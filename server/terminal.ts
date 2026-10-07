import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import pty, { type IPty } from 'node-pty';
import WebSocket from 'ws';
import { sessionSavedOnDisk, watchCodexSessionId } from './session-id';
import { savedSession, saveSession } from './status-store';

export type Agent = 'claude' | 'codex';

type TerminalSession = {
  alertId: string;
  agent: Agent;
  process: IPty;
  output: string;
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  sessionId: string | null;
  sessionSaved: boolean;
  clients: Set<WebSocket>;
};

export type SessionInfo = {
  alertId: string;
  agent: Agent;
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  sessionId: string | null;
  sessionSaved: boolean;
};

const sessions = new Map<string, TerminalSession>();
const MAX_REPLAY = 1_000_000;

function info(session: TerminalSession): SessionInfo {
  return {
    alertId: session.alertId,
    agent: session.agent,
    running: session.running,
    exitCode: session.exitCode,
    startedAt: session.startedAt,
    sessionId: session.sessionId,
    sessionSaved: session.sessionSaved,
  };
}

function broadcast(session: TerminalSession, message: unknown): void {
  const encoded = JSON.stringify(message);
  for (const client of session.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > MAX_REPLAY) {
      client.close(1013, 'Terminal output is behind. Reconnect to catch up.');
      continue;
    }
    client.send(encoded);
  }
}

export function getSession(alertId: string): SessionInfo | null {
  const session = sessions.get(alertId);
  const stored = rememberedSession(alertId);
  if (session?.running || (session && (!stored || stored.id === session.sessionId))) return info(session);
  return stored ? {
    alertId, agent: stored.agent, running: false, exitCode: null, startedAt: '',
    sessionId: stored.id, sessionSaved: stored.saved,
  } : null;
}

export function hasSessionProcess(alertId: string): boolean {
  return sessions.has(alertId);
}

function rememberedSession(alertId: string) {
  const stored = savedSession(alertId);
  if (!stored || stored.saved || !sessionSavedOnDisk(stored.agent, stored.id)) return stored;
  const updated = { ...stored, saved: true };
  saveSession(alertId, updated);
  return updated;
}

export function startSession(alertId: string, agent: Agent, resumeId: string | null = null, fresh = false): SessionInfo {
  const existing = sessions.get(alertId);
  if (existing?.running) {
    if (resumeId || fresh) throw new Error('Stop the current terminal before starting another session.');
    return info(existing);
  }

  const source = process.env.SOURCE || path.join(homedir(), 'source');
  const stateDirectory = agent === 'claude'
    ? path.join(homedir(), '.claude', 'session-env')
    : path.join(homedir(), '.codex');
  try {
    mkdirSync(stateDirectory, { recursive: true });
    const probe = mkdtempSync(path.join(stateDirectory, '.mep-workbench-'));
    rmdirSync(probe);
  } catch {
    throw new Error(`Cannot start ${agent} from this app process: its session directory is blocked. Restart the app from your normal terminal with: cd ~/code/mep-oncall-workbench && npm run dev`);
  }
  const command = agent === 'claude'
    ? (process.env.CLAUDE_CLI_PATH || path.join(path.dirname(process.execPath), 'claude'))
    : (process.env.CODEX_CLI_PATH || path.join(homedir(), '.local', 'bin', 'codex'));
  const stored = rememberedSession(alertId);
  const selectedId = resumeId || (!fresh && stored?.agent === agent && stored.saved ? stored.id : null);
  const claudeId = agent === 'claude' ? selectedId || randomUUID() : null;
  const args = agent === 'codex'
    ? (selectedId ? ['--no-daemon', 'resume', selectedId] : ['--no-daemon'])
    : selectedId ? ['--resume', selectedId] : ['--session-id', claudeId as string];
  const child = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: source,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  const session: TerminalSession = {
    alertId,
    agent,
    process: child,
    output: '',
    running: true,
    exitCode: null,
    startedAt: new Date().toISOString(),
    sessionId: agent === 'claude' ? claudeId : selectedId,
    sessionSaved: Boolean(selectedId),
    clients: new Set(),
  };
  sessions.set(alertId, session);

  if (session.sessionId) saveSession(alertId, { agent, id: session.sessionId, saved: session.sessionSaved });

  if (agent === 'codex') {
    void watchCodexSessionId(child.pid, () => session.running, (id, saved) => {
      if (sessions.get(alertId) !== session) return;
      session.sessionId = id;
      session.sessionSaved = saved;
      saveSession(alertId, { agent, id, saved });
      broadcast(session, { type: 'session', ...info(session) });
    });
  } else {
    void (async () => {
      while (session.running && !session.sessionSaved) {
        if (session.sessionId && sessionSavedOnDisk('claude', session.sessionId)) {
          session.sessionSaved = true;
          saveSession(alertId, { agent, id: session.sessionId, saved: true });
          broadcast(session, { type: 'session', ...info(session) });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
  }

  child.onData((data) => {
    session.output = (session.output + data).slice(-MAX_REPLAY);
    broadcast(session, { type: 'output', data });
  });
  child.onExit(({ exitCode }) => {
    session.running = false;
    session.exitCode = exitCode;
    broadcast(session, { type: 'exit', exitCode });
    if (session.sessionId) {
      setTimeout(() => {
        if (!session.sessionId || !sessionSavedOnDisk(agent, session.sessionId)) return;
        session.sessionSaved = true;
        saveSession(alertId, { agent, id: session.sessionId, saved: true });
      }, 500);
    }
  });

  return info(session);
}

export function stopSession(alertId: string): SessionInfo | null {
  const session = sessions.get(alertId);
  if (!session) return null;
  if (session.running) session.process.kill();
  return info(session);
}

export function attachSession(alertId: string, socket: WebSocket): void {
  const session = sessions.get(alertId);
  if (!session) {
    socket.close(1008, 'Session not found.');
    return;
  }
  session.clients.add(socket);
  socket.send(JSON.stringify({ type: 'session', ...info(session) }));
  if (session.output) socket.send(JSON.stringify({ type: 'output', data: session.output }));

  socket.on('message', (raw) => {
    if (!session.running) return;
    try {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 8192) {
        session.process.write(message.data);
      } else if (
        message.type === 'resize' &&
        Number.isInteger(message.cols) && Number.isInteger(message.rows) &&
        Number(message.cols) >= 20 && Number(message.cols) <= 300 &&
        Number(message.rows) >= 5 && Number(message.rows) <= 150
      ) {
        session.process.resize(Number(message.cols), Number(message.rows));
      }
    } catch {
      // Ignore malformed terminal messages without sending input to the PTY.
    }
  });
  socket.on('close', () => session.clients.delete(socket));
}

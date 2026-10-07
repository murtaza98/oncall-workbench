import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { codexResumeId } from '../shared/resume';
import { workbenchToken } from './api';

type Agent = 'claude' | 'codex';
type Session = { alertId: string; agent: Agent; running: boolean; exitCode: number | null; startedAt: string; sessionId?: string | null; sessionSaved?: boolean };

async function sessionRequest(alertId: string, action?: 'start' | 'stop', agent?: Agent, resumeCommand?: string, fresh = false): Promise<Session | null> {
  const headers: Record<string, string> = {};
  if (action) {
    headers['Content-Type'] = 'application/json';
    headers['x-workbench-token'] = await workbenchToken();
  }
  const response = await fetch(`/api/sessions/${alertId}${action ? `/${action}` : ''}`, {
    method: action ? 'POST' : 'GET',
    headers,
    body: action ? JSON.stringify({ agent, resumeCommand, fresh }) : undefined,
  });
  const payload = await response.json() as { session?: Session | null; error?: string };
  if (!response.ok) throw new Error(payload.error || 'Terminal request failed.');
  return payload.session || null;
}

async function uploadScreenshot(alertId: string, file: File): Promise<string> {
  const response = await fetch(`/api/sessions/${alertId}/image`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-workbench-token': await workbenchToken() },
    body: file,
  });
  const payload = await response.json() as { path?: string; error?: string };
  if (!response.ok || !payload.path) throw new Error(payload.error || 'Could not upload screenshot.');
  return payload.path;
}

export function TerminalPanel({ alertId, visible, onToggle, needsInput }: {
  alertId: string;
  visible: boolean;
  onToggle: () => void;
  needsInput?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [agent, setAgent] = useState<Agent>('codex');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeCommand, setResumeCommand] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const uploadingImageRef = useRef(false);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previous;
    };
  }, [expanded]);

  useEffect(() => {
    let active = true;
    setSession(null);
    setCopiedId(false);
    setResumeOpen(false);
    setResumeCommand('');
    setError('');
    void sessionRequest(alertId)
      .then((value) => { if (active) { setSession(value); if (value) setAgent(value.agent); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load terminal.'); });
    return () => { active = false; };
  }, [alertId]);

  useEffect(() => {
    if (!visible || !session?.startedAt || !terminalHost.current) return;
    const host = terminalHost.current;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      theme: { background: '#17232d', foreground: '#e9f0f4', cursor: '#b9d8e7' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    let socket: WebSocket | null = null;
    terminal.attachCustomKeyEventHandler((event) => {
      if (uploadingImageRef.current && event.key === 'Enter') {
        event.preventDefault();
        return false;
      }
      const shiftEnter = event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      const codexCommandEnter = session.agent === 'codex' && event.key === 'Enter' && event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey;
      if (!shiftEnter && !codexCommandEnter) return true;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'keydown' && !event.repeat && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data: '\n' }));
      }
      return false;
    });
    const resize = () => {
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const frame = requestAnimationFrame(resize);
    let active = true;
    const insertImage = async (file: File) => {
      if (uploadingImageRef.current) return;
      if (socket?.readyState !== WebSocket.OPEN) {
        setError('Reconnect the terminal before pasting a screenshot.');
        return;
      }
      uploadingImageRef.current = true;
      setUploadingImage(true);
      setError('');
      try {
        const path = await uploadScreenshot(alertId, file);
        if (active && socket?.readyState === WebSocket.OPEN) {
          terminal.paste(` Please inspect this screenshot: ${path} `);
          terminal.focus();
        } else if (active) {
          setError(`Screenshot saved at ${path}. Reconnect the terminal and paste this path into Codex.`);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not paste screenshot.');
      } finally {
        uploadingImageRef.current = false;
        if (active) setUploadingImage(false);
      }
    };
    const pasteImage = (event: ClipboardEvent) => {
      if (session.agent !== 'codex') return;
      const file = Array.from(event.clipboardData?.files || []).find((entry) => entry.type.startsWith('image/'));
      if (!file) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void insertImage(file);
    };
    const dragImage = (event: DragEvent) => {
      if (session.agent !== 'codex' || !Array.from(event.dataTransfer?.items || []).some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return;
      event.preventDefault();
    };
    const dropImage = (event: DragEvent) => {
      if (session.agent !== 'codex') return;
      const file = Array.from(event.dataTransfer?.files || []).find((entry) => entry.type.startsWith('image/'));
      if (!file) return;
      event.preventDefault();
      void insertImage(file);
    };
    host.addEventListener('paste', pasteImage, true);
    host.addEventListener('dragover', dragImage, true);
    host.addEventListener('drop', dropImage, true);
    void workbenchToken().then((token) => {
      if (!active) return;
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${location.host}/api/sessions/${alertId}/stream?token=${encodeURIComponent(token)}`);
      socket.addEventListener('open', () => { setConnected(true); resize(); });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; data?: string; exitCode?: number; running?: boolean; sessionId?: string | null; sessionSaved?: boolean };
        if (message.type === 'session') {
          setSession((current) => current && ({ ...current, running: Boolean(message.running), exitCode: message.exitCode ?? null, sessionId: message.sessionId ?? current.sessionId, sessionSaved: message.sessionSaved ?? current.sessionSaved }));
        }
        if (message.type === 'output' && message.data) terminal.write(message.data);
        if (message.type === 'exit') {
          setSession((current) => current && ({ ...current, running: false, exitCode: message.exitCode ?? null }));
        }
      });
      socket.addEventListener('close', () => { if (active) setConnected(false); });
      socket.addEventListener('error', () => { if (active) setError('Terminal connection failed.'); });
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not connect terminal.');
    });
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    return () => {
      active = false;
      setConnected(false);
      cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener('paste', pasteImage, true);
      host.removeEventListener('dragover', dragImage, true);
      host.removeEventListener('drop', dropImage, true);
      input.dispose();
      socket?.close();
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [alertId, visible, session?.startedAt]);

  async function act(action: 'start' | 'stop', command?: string, fresh = false): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      const value = await sessionRequest(alertId, action, command ? 'codex' : session?.agent || agent, command, fresh);
      setSession(value);
      setCopiedId(false);
      if (action === 'stop') {
        const stoppedAt = value?.startedAt;
        window.setTimeout(() => void sessionRequest(alertId).then((latest) => {
          setSession((current) => current?.startedAt === stoppedAt ? latest : current);
        }), 200);
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Terminal request failed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openResume() {
    setResumeCommand(session?.agent === 'codex' && session.sessionId ? `codex resume ${session.sessionId}` : '');
    setResumeOpen(true);
    setError('');
  }

  async function resume() {
    if (!codexResumeId(resumeCommand)) {
      setError('Enter a Codex session ID or a command like codex resume <id>.');
      return;
    }
    if (await act('start', resumeCommand)) setResumeOpen(false);
  }

  async function copySessionId() {
    if (!session?.sessionId) return;
    try {
      await navigator.clipboard.writeText(session.sessionId);
      setCopiedId(true);
    } catch {
      setError('Could not copy the session ID. Select and copy it manually.');
    }
  }

  const resumeForm = resumeOpen && !session?.running && <form className="terminal-resume-form" onSubmit={(event) => { event.preventDefault(); void resume(); }}>
    <label htmlFor={`resume-${alertId}`}>Codex session ID or resume command</label>
    <div><input id={`resume-${alertId}`} value={resumeCommand} onChange={(event) => setResumeCommand(event.target.value)} placeholder="codex resume 01a0…" autoFocus /><button type="submit" disabled={busy}>{busy ? 'Starting…' : 'Resume session'}</button><button type="button" onClick={() => setResumeOpen(false)}>Cancel</button></div>
  </form>;

  return <section className={`terminal-section ${visible ? '' : 'collapsed'} ${expanded ? 'expanded' : ''}`} role={expanded ? 'region' : undefined} aria-label={expanded ? 'Expanded investigation terminal' : undefined}>
    <div className="terminal-heading">
      <div className="terminal-heading-identity"><span className={`terminal-indicator ${session?.running ? 'running' : ''}`} /><strong>Investigation terminal</strong>{session?.running && <span className="terminal-agent">{session.agent}{connected ? ' · connected' : ''}</span>}
        {session && <span className="terminal-session-id"><span>Session ID</span>{session.sessionId ? <><code>{session.sessionId}</code><button onClick={() => void copySessionId()} aria-label={`Copy ${session.agent} session ID`}>{copiedId ? 'Copied' : 'Copy ID'}</button></> : <span>Starting…</span>}</span>}
      </div>
      <div className="terminal-heading-actions">
        {needsInput && <span className="terminal-input-badge">Needs input</span>}
        {visible && session && <button onClick={() => setExpanded((current) => !current)} aria-label={expanded ? 'Restore terminal size' : 'Expand terminal'}>{expanded ? 'Restore' : 'Expand'}</button>}
        <button onClick={() => { setExpanded(false); onToggle(); }} aria-expanded={visible}>{visible ? 'Hide terminal' : 'Show terminal'}</button>
      </div>
    </div>
    {visible && <div className="terminal-body">
      {session ? <>
        <div className="terminal-controls">
          <span>{uploadingImage ? 'Adding screenshot to prompt…' : session.running ? 'Session stays open when hidden or when you switch items.' : session.sessionSaved ? 'Saved chat is ready to resume.' : `Session exited${session.exitCode === null ? '' : ` (${session.exitCode})`}.`}</span>
          <div className="terminal-control-actions">
            {session.running ? <button onClick={() => void act('stop')} disabled={busy}>Stop session</button> : <>
              {session.sessionSaved && <button onClick={() => void act('start')} disabled={busy}>Resume {session.agent} session</button>}
              <button onClick={() => void act('start', undefined, true)} disabled={busy}>Start new {session.agent} session</button>
              <button onClick={openResume} disabled={busy}>Resume Codex…</button>
            </>}
          </div>
        </div>
        {resumeForm}
        <div ref={terminalHost} className="terminal-viewport" aria-label={`${session.agent} terminal for selected alert`} />
      </> : <div className="terminal-empty">
        <span>Start an investigation session for this work item in ~/source.</span>
        <div><select value={agent} onChange={(event) => setAgent(event.target.value as Agent)} aria-label="Terminal agent"><option value="codex">Codex</option><option value="claude">Claude Code</option></select><button onClick={() => void act('start')} disabled={busy}>{busy ? 'Starting…' : 'Start terminal'}</button><button onClick={openResume} disabled={busy}>Resume Codex…</button></div>
      </div>}
      {!session && resumeForm}
      {error && <p className="terminal-error" role="alert">{error}</p>}
    </div>}
  </section>;
}

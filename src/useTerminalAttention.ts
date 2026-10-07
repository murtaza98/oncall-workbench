import { useEffect, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { workbenchToken } from './api';
import { screenNeedsInput } from './terminal-attention';

type Session = { running: boolean; startedAt: string };
type Watch = { startedAt: string; socket: WebSocket; terminal: Terminal };

function currentScreen(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < terminal.rows; row++) {
    lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) || '');
  }
  return lines.join('\n');
}

export function useTerminalAttention(alertIds: string[]): Set<string> {
  const [needsInput, setNeedsInput] = useState<Set<string>>(() => new Set());
  const ids = alertIds.join(',');

  useEffect(() => {
    setNeedsInput(new Set());
    if (!ids) return;
    let active = true;
    let scanning = false;
    const watches = new Map<string, Watch>();
    const connecting = new Set<string>();

    function setAttention(id: string, value: boolean) {
      if (!active) return;
      setNeedsInput((previous) => {
        if (previous.has(id) === value) return previous;
        const next = new Set(previous);
        if (value) next.add(id);
        else next.delete(id);
        return next;
      });
    }

    function closeWatch(id: string) {
      const watch = watches.get(id);
      if (watch) {
        watch.socket.close();
        watch.terminal.dispose();
        watches.delete(id);
      }
      setAttention(id, false);
    }

    async function watchSession(id: string, session: Session) {
      const token = await workbenchToken();
      if (!active) return;
      const terminal = new Terminal({ cols: 100, rows: 30, scrollback: 100 });
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}/api/sessions/${id}/stream?token=${encodeURIComponent(token)}`);
      watches.set(id, { startedAt: session.startedAt, socket, terminal });
      socket.addEventListener('message', (event) => {
        if (!active || watches.get(id)?.socket !== socket) return;
        const message = JSON.parse(String(event.data)) as { type: string; data?: string };
        if (message.type === 'output' && message.data) {
          terminal.write(message.data, () => {
            if (active && watches.get(id)?.socket === socket) setAttention(id, screenNeedsInput(currentScreen(terminal)));
          });
        } else if (message.type === 'exit') {
          setAttention(id, false);
        }
      });
      socket.addEventListener('close', () => {
        if (watches.get(id)?.socket === socket) setAttention(id, false);
      });
    }

    async function scan() {
      if (scanning || !active) return;
      scanning = true;
      try {
        const found = await Promise.all(ids.split(',').map(async (id) => {
          try {
            const response = await fetch(`/api/sessions/${id}`);
            if (!response.ok) return { id, session: undefined };
            const payload = await response.json() as { session: Session | null };
            return { id, session: payload.session };
          } catch {
            return { id, session: undefined };
          }
        }));
        if (!active) return;
        for (const { id, session } of found) {
          if (session === undefined) continue;
          if (!session?.running) {
            closeWatch(id);
            continue;
          }
          const existing = watches.get(id);
          if (existing?.startedAt === session.startedAt && existing.socket.readyState !== WebSocket.CLOSED) continue;
          if (connecting.has(id)) continue;
          if (existing) closeWatch(id);
          connecting.add(id);
          void watchSession(id, session)
            .catch(() => setAttention(id, false))
            .finally(() => connecting.delete(id));
        }
      } finally {
        scanning = false;
      }
    }

    void scan();
    const timer = window.setInterval(() => void scan(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      for (const watch of watches.values()) {
        watch.socket.close();
        watch.terminal.dispose();
      }
      watches.clear();
    };
  }, [ids]);

  return needsInput;
}

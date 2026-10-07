import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const sessionDirectory = path.join(homedir(), '.codex', 'sessions') + path.sep;
const writerLockDirectory = path.join(homedir(), '.codex', 'thread-writer-locks') + path.sep;
const sessionId = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const writerLockName = new RegExp(`^(${sessionId})\\.lock$`, 'i');
const rolloutName = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function savedRolloutExists(id: string): boolean {
  const encodedTime = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
  const dates = [Date.now(), encodedTime].filter((value) => Number.isFinite(value) && value > 0 && value <= Date.now() + 86_400_000);
  for (const time of dates) for (const offset of [-1, 0, 1]) {
    const day = new Date(time + offset * 86_400_000);
    const folder = path.join(sessionDirectory, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    try {
      if (readdirSync(folder).some((name) => name.endsWith(`-${id}.jsonl`))) return true;
    } catch {
      // The directory may not exist before the first Codex session that day.
    }
  }
  return false;
}

export function sessionSavedOnDisk(agent: 'codex' | 'claude', id: string): boolean {
  if (agent === 'codex') return savedRolloutExists(id);
  const source = process.env.SOURCE || path.join(homedir(), 'source');
  const project = source.replaceAll(path.sep, '-');
  return existsSync(path.join(homedir(), '.claude', 'projects', project, `${id}.jsonl`));
}

export function codexSessionIdFromOpenFiles(output: string): string | null {
  const lockIds = new Set<string>();
  const ids = new Set<string>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('n')) continue;
    const file = line.slice(1);
    if (file.startsWith(writerLockDirectory)) {
      const match = writerLockName.exec(path.basename(file));
      if (match) lockIds.add(match[1]);
    } else if (file.startsWith(sessionDirectory)) {
      const match = rolloutName.exec(path.basename(file));
      if (match) ids.add(match[1]);
    }
  }
  if (lockIds.size > 0) {
    return lockIds.size === 1 ? [...lockIds][0] : null;
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function openFiles(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-n', '-P', '-p', String(pid), '-Fn'], { timeout: 2000 }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

export async function watchCodexSessionId(pid: number, stillRunning: () => boolean, onUpdate: (id: string, saved: boolean) => void): Promise<void> {
  let lastId: string | null = null;
  let lastSaved = false;
  while (stillRunning()) {
    const id = codexSessionIdFromOpenFiles(await openFiles(pid));
    if (id) {
      const saved = savedRolloutExists(id);
      if (id !== lastId || saved !== lastSaved) {
        onUpdate(id, saved);
        lastId = id;
        lastSaved = saved;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

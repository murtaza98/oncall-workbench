import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AlertStatus } from '../shared/model';

export type SavedSession = { agent: 'codex' | 'claude'; id: string; saved: boolean };
type SavedRecord = { status: AlertStatus; updatedAt: string; jira: string[]; prs: string[]; session?: SavedSession };
const directory = path.join(process.cwd(), 'data');
const file = path.join(directory, 'statuses.json');
const allowed = new Set<AlertStatus>(['todo', 'triaging', 'backlog', 'in_progress', 'review', 'merge_deploy_pending', 'done']);
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(alertId: string): string {
  return createHash('sha256').update(`C08122YHE5D:${alertId}`).digest('hex');
}

function load(): Record<string, SavedRecord> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const valid: Record<string, SavedRecord> = {};
    for (const [id, item] of Object.entries(raw)) {
      if (!/^[a-f0-9]{64}$/.test(id) || !item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      if (allowed.has(value.status as AlertStatus) && typeof value.updatedAt === 'string') {
        valid[id] = {
          status: value.status as AlertStatus,
          updatedAt: value.updatedAt,
          jira: Array.isArray(value.jira) ? value.jira.filter((entry): entry is string => typeof entry === 'string' && /^[A-Z][A-Z0-9]+-\d+$/.test(entry)) : [],
          prs: Array.isArray(value.prs) ? value.prs.filter((entry): entry is string => typeof entry === 'string' && /^https:\/\/github\.com\/abnormal-security\/[\w.-]+\/pull\/\d+$/.test(entry)) : [],
        };
        if (value.session && typeof value.session === 'object') {
          const session = value.session as Record<string, unknown>;
          if ((session.agent === 'codex' || session.agent === 'claude') && typeof session.id === 'string' && sessionIdPattern.test(session.id)) {
            valid[id].session = { agent: session.agent, id: session.id, saved: session.saved === true };
          }
        }
      }
    }
    return valid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

const statuses = load();

export function savedRecord(alertId: string): SavedRecord | null {
  return statuses[key(alertId)] || null;
}

export function savedSession(itemId: string): SavedSession | null {
  return savedRecord(itemId)?.session || null;
}

export function allLinkedJiraKeys(): Set<string> {
  return new Set(Object.values(statuses).flatMap((record) => record.jira));
}

function save(alertId: string, value: SavedRecord): void {
  const id = key(alertId);
  const previous = statuses[id];
  statuses[id] = value;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `statuses.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(statuses, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    if (previous) statuses[id] = previous;
    else delete statuses[id];
    throw error;
  }
}

export function saveStatus(alertId: string, status: AlertStatus, updatedAt: string): void {
  save(alertId, { ...(savedRecord(alertId) || { jira: [], prs: [] }), status, updatedAt });
}

export function ensureStatus(itemId: string, status: AlertStatus): SavedRecord {
  const existing = savedRecord(itemId);
  if (existing) return existing;
  const created = { status, updatedAt: new Date().toISOString(), jira: [], prs: [] };
  save(itemId, created);
  return created;
}

export function saveSession(itemId: string, session: SavedSession): void {
  if (!sessionIdPattern.test(session.id)) throw new Error('Invalid session ID.');
  save(itemId, { ...(savedRecord(itemId) || { status: 'todo', updatedAt: new Date().toISOString(), jira: [], prs: [] }), session });
}

export function saveLink(alertId: string, kind: 'jira' | 'prs', reference: string, action: 'add' | 'remove'): SavedRecord {
  const current = savedRecord(alertId) || { status: 'todo', updatedAt: new Date().toISOString(), jira: [], prs: [] };
  const values = new Set(current[kind]);
  if (action === 'add') values.add(reference);
  else values.delete(reference);
  if (values.size > 10) throw new Error('Limit each alert to 10 links of each type.');
  const next = { ...current, [kind]: [...values] };
  save(alertId, next);
  return next;
}

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Alert } from '../shared/model';
import { CHANNEL_ID } from './slack';

const execFileAsync = promisify(execFile);
type PagerDutyInfo = NonNullable<Alert['pagerDuty']>;
const cache = new Map<string, { readAt: number; replyCount: number; info: PagerDutyInfo }>();
const pending = new Map<string, Promise<PagerDutyInfo>>();
const CACHE_MS = 300_000;

export function pagerDutyStatusFromThread(value: unknown, alertId: string, incidentUrl: string): PagerDutyInfo {
  const unavailable: PagerDutyInfo = { status: 'unknown', incidentUrl, updatedAt: null };
  if (!value || typeof value !== 'object') return unavailable;
  const thread = value as Record<string, unknown>;
  if (thread.status !== 'success' || !Array.isArray(thread.messages) || thread.messages.length >= 200 ||
      (thread.pagination && typeof thread.pagination === 'object' && (thread.pagination as Record<string, unknown>).has_more)) return unavailable;

  const messages = thread.messages.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
  const root = messages.find((message) => message.ts === alertId);
  if (root?.user_id !== 'UC3V95762' || typeof root.text !== 'string' || !root.text.includes(incidentUrl)) return unavailable;

  for (const message of messages.sort((left, right) => Number(left.ts) - Number(right.ts)).reverse()) {
    if (message.user_id !== 'UC3V95762' || typeof message.text !== 'string' || typeof message.ts !== 'string') continue;
    const match = /^(Triggered|Acknowledged|Resolved|Reopened): Incident \d+\b/i.exec(message.text.trim());
    if (!match) continue;
    const event = match[1].toLowerCase();
    const status = event === 'reopened' ? 'triggered' : event as PagerDutyInfo['status'];
    const time = Number(message.ts) * 1000;
    return { status, incidentUrl, updatedAt: Number.isFinite(time) ? new Date(time).toISOString() : null };
  }
  return unavailable;
}

async function readPagerDutyStatus(alert: Alert): Promise<PagerDutyInfo> {
  const info = alert.pagerDuty as PagerDutyInfo;
  if (!alert.hasThread) return info;
  const source = process.env.SOURCE || path.join(homedir(), 'source');
  const cli = process.env.SLACK_CLI_PATH || path.join(source, 'bin', 'slack');
  try {
    const { stdout } = await execFileAsync(cli, ['--output', 'json', 'get-thread', CHANNEL_ID, alert.id], {
      cwd: source, timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
    });
    return pagerDutyStatusFromThread(JSON.parse(stdout) as unknown, alert.id, info.incidentUrl);
  } catch {
    return info;
  }
}

async function resolvePagerDutyStatus(alert: Alert, force: boolean): Promise<PagerDutyInfo> {
  const cached = cache.get(alert.id);
  if (!force && cached && cached.replyCount === alert.replyCount && Date.now() - cached.readAt < CACHE_MS) return cached.info;
  const current = pending.get(alert.id);
  if (current) return current;
  const task = readPagerDutyStatus(alert);
  pending.set(alert.id, task);
  try {
    const info = await task;
    cache.set(alert.id, { readAt: Date.now(), replyCount: alert.replyCount, info });
    return info;
  } finally {
    pending.delete(alert.id);
  }
}

export async function enrichPagerDutyAlerts(alerts: Alert[], force = false): Promise<Alert[]> {
  const result = [...alerts];
  const indexes = alerts.flatMap((alert, index) => alert.pagerDuty ? [index] : []);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, indexes.length) }, async () => {
    while (next < indexes.length) {
      const index = indexes[next++];
      result[index] = { ...alerts[index], pagerDuty: await resolvePagerDutyStatus(alerts[index], force) };
    }
  }));
  return result;
}

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Alert, Shift } from '../shared/model';

const execFileAsync = promisify(execFile);
export const CHANNEL_ID = 'C08122YHE5D';

const knownAlertSenders = new Set([
  'UC3V95762', // PagerDuty
  'U02FP39PEC9', // Abnormal Slack Integration
  'U03RL5SB0B0', // Daffodil
]);

const notificationTitles = [
  /^Internal Abnormal user changed outbound DLP config\s*[—–-]\s*\d+ change\(s\)$/i,
  /^(?:Client Map Sync Completed|DLQ Replay Complete|DLQ Replay Dry Run|MEP Enablement Succeeded|Outbound DLP Config Changed)$/i,
];

export function isNotificationTitle(title: string): boolean {
  return notificationTitles.some((pattern) => pattern.test(title));
}

type SlackMessage = {
  ts: string;
  text: string;
  user_id?: string;
  user_name?: string;
  permalink?: string;
  has_thread?: boolean;
  reply_count?: number;
  timestamp_human?: string;
};

type SlackHistory = {
  status: string;
  messages?: SlackMessage[];
  pagination?: { has_more?: boolean };
};

async function runSlack(args: string[]): Promise<unknown> {
  const source = process.env.SOURCE || path.join(homedir(), 'source');
  const cli = process.env.SLACK_CLI_PATH || path.join(source, 'bin', 'slack');
  try {
    const { stdout } = await execFileAsync(cli, args, {
      cwd: source,
      timeout: 45_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('Slack is unavailable. Check VPN and abnml_login, then refresh.');
  }
}

function isHistory(value: unknown): value is SlackHistory {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return data.status === 'success' && Array.isArray(data.messages);
}

async function fetchWindow(start: Date, end: Date, depth = 0): Promise<SlackMessage[]> {
  const value = await runSlack([
    'get-channel-history',
    CHANNEL_ID,
    '--since', start.toISOString(),
    '--until', end.toISOString(),
    '--limit', '100',
    '--output', 'json',
  ]);
  if (!isHistory(value)) throw new Error('Slack returned an unexpected response.');
  if (!value.pagination?.has_more) return value.messages ?? [];

  const middle = new Date(Math.floor((start.getTime() + end.getTime()) / 2));
  if (depth >= 12 || middle.getTime() - start.getTime() < 60_000) {
    throw new Error('The channel has more alerts than this time window can load.');
  }
  const [first, second] = await Promise.all([
    fetchWindow(start, middle, depth + 1),
    fetchWindow(middle, end, depth + 1),
  ]);
  return [...first, ...second];
}

export function plainText(text: string): string {
  return text
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/:[a-z0-9_+-]+:/gi, '')
    .replace(/[*_`~]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function toAlert(message: SlackMessage): Alert {
  const cleaned = plainText(message.text);
  const title = cleaned.split('\n').find((line) => line.trim())?.trim() || 'Untitled channel post';
  const timestamp = new Date(Number(message.ts) * 1000).toISOString();
  const pagerDutyUrl = message.user_id === 'UC3V95762'
    ? message.text.match(/https:\/\/abnormalsecurity\.pagerduty\.com\/incidents\/[A-Z0-9]+/i)?.[0]
    : undefined;

  return {
    id: message.ts,
    pagerDuty: pagerDutyUrl ? { status: 'unknown', incidentUrl: pagerDutyUrl, updatedAt: null } : undefined,
    channelId: CHANNEL_ID,
    source: message.user_name || 'Unknown sender',
    title: title.slice(0, 180),
    text: cleaned,
    timestamp,
    permalink: message.permalink?.startsWith(`https://abnormalsecurity.slack.com/archives/${CHANNEL_ID}/`)
      ? message.permalink
      : `https://abnormalsecurity.slack.com/archives/${CHANNEL_ID}/p${message.ts.replace('.', '')}`,
    hasThread: Boolean(message.has_thread),
    replyCount: message.reply_count || 0,
    isAlert: knownAlertSenders.has(message.user_id || '') && !isNotificationTitle(title),
    workflow: { status: 'todo', updatedAt: null },
    links: { jira: [], prs: [] },
  };
}

export async function fetchShiftPosts(shift: Shift): Promise<Alert[]> {
  const messages = await fetchWindow(new Date(shift.start), new Date(shift.end));
  const deduplicated = new Map<string, SlackMessage>();
  for (const message of messages) deduplicated.set(message.ts, message);

  return [...deduplicated.values()]
    .filter((message) => {
      const timestamp = Number(message.ts) * 1000;
      return timestamp >= Date.parse(shift.start) && timestamp < Date.parse(shift.end);
    })
    .map(toAlert)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

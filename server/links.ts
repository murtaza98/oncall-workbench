import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AlertLinks, LinkedItem } from '../shared/model';

const execFileAsync = promisify(execFile);
const source = process.env.SOURCE || path.join(homedir(), 'source');
const cache = new Map<string, { until: number; result: LinkedItem }>();

export function normalizeLink(kind: 'jira' | 'pr', input: string): string | null {
  const value = input.trim();
  if (kind === 'jira') {
    const key = value.match(/^[A-Z][A-Z0-9]+-\d+$/i)?.[0]
      || value.match(/^https:\/\/abnormalsecurity\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)\/?$/i)?.[1];
    return key?.toUpperCase() || null;
  }
  const short = value.match(/^#?(\d+)$/);
  if (short) return `https://github.com/abnormal-security/source/pull/${Number(short[1])}`;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/abnormal-security\/([\w.-]+)\/pull\/(\d+)\/?$/);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match) return null;
    return `https://github.com/abnormal-security/${match[1]}/pull/${Number(match[2])}`;
  } catch {
    return null;
  }
}

async function lookupJira(key: string): Promise<LinkedItem> {
  const url = `https://abnormalsecurity.atlassian.net/browse/${key}`;
  try {
    const { stdout } = await execFileAsync(path.join(source, 'bin', 'abjira'),
      ['--output', 'json', 'issue', 'view', key], { cwd: source, timeout: 20_000, maxBuffer: 2_000_000 });
    const issue = JSON.parse(stdout) as { status?: string };
    return { reference: key, url, status: issue.status || 'Unknown' };
  } catch {
    return { reference: key, url, status: 'Unavailable' };
  }
}

async function lookupPr(url: string): Promise<LinkedItem> {
  const match = url.match(/^https:\/\/github\.com\/abnormal-security\/([\w.-]+)\/pull\/(\d+)$/);
  if (!match) return { reference: url, url, status: 'Unavailable' };
  const reference = `${match[1]}#${match[2]}`;
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', match[2], '--repo', `abnormal-security/${match[1]}`,
      '--json', 'state,isDraft,mergedAt'], { cwd: source, timeout: 20_000, maxBuffer: 1_000_000 });
    const pr = JSON.parse(stdout) as { state?: string; isDraft?: boolean; mergedAt?: string | null };
    const status = pr.mergedAt ? 'Merged' : pr.isDraft ? 'Draft' : pr.state === 'OPEN' ? 'Open' : pr.state === 'CLOSED' ? 'Closed' : 'Unknown';
    return { reference, url, status };
  } catch {
    return { reference, url, status: 'Unavailable' };
  }
}

async function cachedLookup(kind: 'jira' | 'pr', reference: string): Promise<LinkedItem> {
  const key = `${kind}:${reference}`;
  const prior = cache.get(key);
  if (prior && prior.until > Date.now()) return prior.result;
  const result = kind === 'jira' ? await lookupJira(reference) : await lookupPr(reference);
  cache.set(key, { until: Date.now() + 60_000, result });
  return result;
}

export async function resolveLinks(jira: string[], prs: string[]): Promise<AlertLinks> {
  const [tickets, pulls] = await Promise.all([
    Promise.all(jira.map((key) => cachedLookup('jira', key))),
    Promise.all(prs.map((url) => cachedLookup('pr', url))),
  ]);
  return { jira: tickets, prs: pulls };
}

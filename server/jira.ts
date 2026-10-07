import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Alert, AlertStatus, JiraIssue, JiraSprint } from '../shared/model';

const execFileAsync = promisify(execFile);
const source = process.env.SOURCE || path.join(homedir(), 'source');
const cli = path.join(source, 'bin', 'abjira');

async function runAbjira(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(cli, args, {
    cwd: source,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}

export function parseActiveSprint(value: unknown): JiraSprint | null {
  if (!Array.isArray(value)) throw new Error('Jira returned an unexpected sprint list.');
  const active = value.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === 'object' && item.state === 'active'));
  if (active.length === 0) return null;
  if (active.length !== 1) throw new Error('MEP has multiple active sprints; choose one before syncing Jira.');
  const [item] = active;
  if (!Number.isInteger(item.id) || typeof item.name !== 'string' || typeof item.startDate !== 'string' || typeof item.endDate !== 'string') {
    throw new Error('Jira returned incomplete sprint details.');
  }
  return { id: item.id as number, name: item.name, startDate: item.startDate, endDate: item.endDate };
}

export function parseJiraIssues(value: unknown): JiraIssue[] {
  if (!Array.isArray(value)) throw new Error('Jira returned an unexpected issue list.');
  if (value.length >= 500) throw new Error('Jira returned 500 issues; the list may be incomplete.');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Jira returned an invalid issue.');
    const fields = item as Record<string, unknown>;
    if (typeof fields.key !== 'string' || !/^[A-Z][A-Z0-9]+-\d+$/.test(fields.key) ||
        typeof fields.summary !== 'string' || typeof fields.status !== 'string' ||
        typeof fields.updated !== 'string') {
      throw new Error('Jira returned an issue with missing fields.');
    }
    return {
      key: fields.key,
      summary: fields.summary,
      status: fields.status,
      type: typeof fields.type === 'string' ? fields.type : 'Issue',
      updated: fields.updated,
      url: `https://abnormalsecurity.atlassian.net/browse/${fields.key}`,
    };
  });
}

export function ticketsWithoutAlertRoot(issues: JiraIssue[], alerts: Pick<Alert, 'links'>[]): JiraIssue[] {
  const linked = new Set(alerts.flatMap((alert) => alert.links.jira.map((item) => item.reference)));
  return issues.filter((issue) => !linked.has(issue.key));
}

export function initialJiraWorkflowStatus(status: string): AlertStatus {
  const value = status.toLowerCase();
  if (/done|duplicate|closed|resolved|cancelled/.test(value)) return 'done';
  if (/pending deployment|merge and deploy/.test(value)) return 'merge_deploy_pending';
  if (/review|pending push/.test(value)) return 'review';
  if (/blocked|backlog/.test(value)) return 'backlog';
  if (/progress|development/.test(value)) return 'in_progress';
  return 'todo';
}

export async function fetchActiveSprintIssues(): Promise<{ sprint: JiraSprint | null; issues: JiraIssue[] }> {
  const sprint = parseActiveSprint(await runAbjira(['sprint', 'list', '-p', 'MEP', '--state', 'active']));
  if (!sprint) return { sprint: null, issues: [] };
  const issues = parseJiraIssues(await runAbjira([
    'issue', 'list', '-q', `assignee = currentUser() AND sprint = ${sprint.id} ORDER BY updated DESC`,
    '--limit', '500',
  ]));
  return { sprint, issues };
}

import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Alert, AlertStatus, AlertsResponse, Workflow } from '../shared/model';
import { codexResumeId } from '../shared/resume';
import { CHANNEL_ID, fetchShiftPosts } from './slack';
import { shiftFor } from './shift';
import { normalizeLink, resolveLinks } from './links';
import { ensureStatus, savedRecord, savedSession, saveLink, saveSession, saveStatus } from './status-store';
import { attachSession, getSession, hasSessionProcess, startSession, stopSession, type Agent } from './terminal';
import { ImageUploadError, saveUploadedImage } from './images';
import { fetchActiveSprintIssues, initialJiraWorkflowStatus, ticketsWithoutAlertRoot } from './jira';
import { allLinkedJiraKeys } from './status-store';
import { sessionSavedOnDisk } from './session-id';
import { enrichPagerDutyAlerts } from './pagerduty';

const PORT = Number(process.env.MEP_WORKBENCH_PORT || 4171);
const accessToken = randomBytes(32).toString('base64url');
const cached = new Map<number, { time: number; value: AlertsResponse }>();
const pending = new Map<number, Promise<AlertsResponse>>();
const knownAlertIds = new Set<string>();
const statuses = new Set<AlertStatus>([
  'todo', 'triaging', 'backlog', 'in_progress', 'review', 'merge_deploy_pending', 'done',
]);
const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://127.0.0.1:4171']);

function localHost(host: string | undefined): boolean {
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function authorizedWrite(origin: string | undefined, token: string | string[] | undefined): boolean {
  return allowedOrigins.has(origin || '') && token === accessToken;
}

function sendJson(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function loadAlerts(offset: number, force: boolean): Promise<AlertsResponse> {
  const cachedEntry = cached.get(offset);
  if (!force && cachedEntry && Date.now() - cachedEntry.time < 60_000) {
    return cachedEntry.value;
  }
  const existing = pending.get(offset);
  if (existing) return existing;

  const task = (async () => {
    const now = new Date();
    const shift = shiftFor(now, offset);
    const [shiftPosts, jira] = await Promise.all([
      fetchShiftPosts(shift),
      offset === 0
        ? fetchActiveSprintIssues().then((result) => ({ ...result, error: null as string | null }))
          .catch(() => ({ sprint: null, issues: [], error: 'Jira sync unavailable. Check abjira login or VPN, then refresh.' }))
        : Promise.resolve({ sprint: null, issues: [], error: null }),
    ]);
    const carried = [] as typeof shiftPosts;
    if (offset === 0 && jira.issues.length > 0) {
      const savedKeys = allLinkedJiraKeys();
      const missing = new Set(jira.issues.map((issue) => issue.key).filter((key) => savedKeys.has(key)));
      for (const post of shiftPosts) {
        for (const key of savedRecord(post.id)?.jira || []) missing.delete(key);
      }
      for (let weeksBack = 1; weeksBack <= 12 && missing.size > 0; weeksBack++) {
        let olderPosts: typeof shiftPosts;
        try {
          olderPosts = await fetchShiftPosts(shiftFor(now, -weeksBack));
        } catch {
          break;
        }
        for (const post of olderPosts) {
          if (!post.isAlert) continue;
          const keys = savedRecord(post.id)?.jira || [];
          if (!keys.some((key) => missing.has(key))) continue;
          carried.push({ ...post, carriedFromShift: true });
          for (const key of keys) missing.delete(key);
        }
      }
    }
    const posts = await Promise.all([...shiftPosts, ...carried].map(async (post) => {
      const saved = savedRecord(post.id);
      return {
        ...post,
        workflow: saved ? { status: saved.status, updatedAt: saved.updatedAt } : post.workflow,
        links: saved && post.isAlert ? await resolveLinks(saved.jira, saved.prs) : post.links,
      };
    }));
    const postsWithPagerDuty = await enrichPagerDutyAlerts(posts, force);
    const jiraAlerts = await Promise.all(ticketsWithoutAlertRoot(jira.issues, postsWithPagerDuty.filter((post) => post.isAlert)).map(async (issue): Promise<Alert> => {
      const id = `jira-${issue.key}`;
      const saved = ensureStatus(id, initialJiraWorkflowStatus(issue.status));
      return {
        id, kind: 'jira', jira: { key: issue.key, status: issue.status, type: issue.type },
        channelId: '', source: `Jira · ${issue.key}`, title: issue.summary, text: issue.summary,
        timestamp: new Date(issue.updated).toISOString(), permalink: issue.url,
        hasThread: false, replyCount: 0, isAlert: true,
        workflow: { status: saved.status, updatedAt: saved.updatedAt },
        links: await resolveLinks(saved.jira, saved.prs),
      };
    }));
    const value: AlertsResponse = {
      shift,
      alerts: [...postsWithPagerDuty.filter((post) => post.isAlert), ...jiraAlerts],
      otherPosts: postsWithPagerDuty.filter((post) => !post.isAlert && !post.carriedFromShift),
      jiraSprint: jira.sprint,
      jiraError: jira.error,
      syncedAt: new Date().toISOString(),
    };
    for (const alert of value.alerts) knownAlertIds.add(alert.id);
    cached.set(offset, { time: Date.now(), value });
    return value;
  })();
  pending.set(offset, task);
  try {
    return await task;
  } finally {
    pending.delete(offset);
  }
}

async function readBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 16_384) throw new Error('Request is too large.');
  }
  return JSON.parse(body) as unknown;
}

const server = createServer(async (request, response) => {
  const host = request.headers.host;
  if (!localHost(host)) {
    sendJson(response, 403, { error: 'Local requests only.' });
    return;
  }
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);
  try {
    const workflowMatch = url.pathname.match(/^\/api\/alerts\/((?:\d{10}\.\d{6}|jira-[A-Z][A-Z0-9]+-\d+))\/workflow$/);
    if (workflowMatch && request.method === 'POST') {
      if (!authorizedWrite(request.headers.origin, request.headers['x-workbench-token'])) {
        sendJson(response, 403, { error: 'Invalid request origin or token.' });
        return;
      }
      if (!knownAlertIds.has(workflowMatch[1])) {
        sendJson(response, 404, { error: 'Alert not found in a synced shift.' });
        return;
      }
      const input = await readBody(request);
      if (!input || typeof input !== 'object') {
        sendJson(response, 400, { error: 'Invalid workflow update.' });
        return;
      }
      const fields = input as Record<string, unknown>;
      if (typeof fields.status !== 'string' || !statuses.has(fields.status as AlertStatus)) {
        sendJson(response, 400, { error: 'Invalid workflow update.' });
        return;
      }
      const updatedAt = new Date().toISOString();
      const workflow: Workflow = {
        status: fields.status as AlertStatus,
        updatedAt,
      };
      saveStatus(workflowMatch[1], workflow.status, updatedAt);
      cached.clear();
      sendJson(response, 200, { workflow });
      return;
    }
    const linksMatch = url.pathname.match(/^\/api\/alerts\/((?:\d{10}\.\d{6}|jira-[A-Z][A-Z0-9]+-\d+))\/links$/);
    if (linksMatch && request.method === 'POST') {
      if (!authorizedWrite(request.headers.origin, request.headers['x-workbench-token'])) {
        sendJson(response, 403, { error: 'Invalid request origin or token.' });
        return;
      }
      if (!knownAlertIds.has(linksMatch[1])) {
        sendJson(response, 404, { error: 'Alert not found in a synced shift.' });
        return;
      }
      const input = await readBody(request);
      if (!input || typeof input !== 'object') {
        sendJson(response, 400, { error: 'Invalid link.' });
        return;
      }
      const fields = input as Record<string, unknown>;
      const kind = fields.kind;
      const action = fields.action;
      const value = fields.value;
      if ((kind !== 'jira' && kind !== 'pr') || (action !== 'add' && action !== 'remove') || typeof value !== 'string') {
        sendJson(response, 400, { error: 'Invalid link.' });
        return;
      }
      const reference = normalizeLink(kind, value);
      if (!reference) {
        sendJson(response, 400, { error: kind === 'jira' ? 'Enter a Jira key such as MEP-123.' : 'Enter a PR number or abnormal-security GitHub PR URL.' });
        return;
      }
      if (kind === 'jira' && action === 'add' && getSession(`jira-${reference}`)?.running) {
        sendJson(response, 409, { error: 'Stop the Jira investigation terminal before linking this ticket to an alert.' });
        return;
      }
      const saved = saveLink(linksMatch[1], kind === 'jira' ? 'jira' : 'prs', reference, action);
      if (kind === 'jira' && action === 'add' && !savedSession(linksMatch[1])) {
        const jiraSession = savedSession(`jira-${reference}`);
        if (jiraSession) saveSession(linksMatch[1], jiraSession);
      }
      cached.clear();
      sendJson(response, 200, { links: await resolveLinks(saved.jira, saved.prs) });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/((?:\d{10}\.\d{6}|jira-[A-Z][A-Z0-9]+-\d+))$/);
    const rememberMatch = url.pathname.match(/^\/api\/sessions\/((?:\d{10}\.\d{6}|jira-[A-Z][A-Z0-9]+-\d+))\/remember$/);
    if (rememberMatch && request.method === 'POST') {
      if (!authorizedWrite(request.headers.origin, request.headers['x-workbench-token'])) {
        sendJson(response, 403, { error: 'Invalid request origin or token.' });
        return;
      }
      if (!knownAlertIds.has(rememberMatch[1])) {
        sendJson(response, 404, { error: 'Work item not found in a synced shift.' });
        return;
      }
      if (getSession(rememberMatch[1])?.running) {
        sendJson(response, 409, { error: 'Stop the running terminal before linking another chat.' });
        return;
      }
      const input = await readBody(request);
      const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      if ((fields.agent !== 'codex' && fields.agent !== 'claude') || typeof fields.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.id) ||
          !sessionSavedOnDisk(fields.agent, fields.id)) {
        sendJson(response, 400, { error: 'Enter an existing local Codex or Claude session ID.' });
        return;
      }
      saveSession(rememberMatch[1], { agent: fields.agent, id: fields.id, saved: true });
      sendJson(response, 200, { session: getSession(rememberMatch[1]) });
      return;
    }
    const imageMatch = url.pathname.match(/^\/api\/sessions\/((?:\d{10}\.\d{6}|jira-[A-Z][A-Z0-9]+-\d+))\/image$/);
    if (imageMatch && request.method === 'POST') {
      if (!authorizedWrite(request.headers.origin, request.headers['x-workbench-token'])) {
        sendJson(response, 403, { error: 'Invalid request origin or token.' });
        return;
      }
      const session = getSession(imageMatch[1]);
      if (!session?.running || session.agent !== 'codex') {
        sendJson(response, 409, { error: 'Start a Codex terminal before pasting a screenshot.' });
        return;
      }
      try {
        sendJson(response, 200, { path: await saveUploadedImage(request) });
      } catch (error) {
        if (!(error instanceof ImageUploadError)) throw error;
        sendJson(response, error.status, { error: error.message });
      }
      return;
    }
    const sessionActionMatch = url.pathname.match(/^\/api\/sessions\/((?:\d{10}\.\d{6}|jira-[A-Z][A-Z0-9]+-\d+))\/(start|stop)$/);
    if (sessionActionMatch && request.method === 'POST') {
      if (!authorizedWrite(request.headers.origin, request.headers['x-workbench-token'])) {
        sendJson(response, 403, { error: 'Invalid request origin or token.' });
        return;
      }
      const alertId = sessionActionMatch[1];
      if (!knownAlertIds.has(alertId)) {
        sendJson(response, 404, { error: 'Alert not found in a synced shift.' });
        return;
      }
      if (sessionActionMatch[2] === 'stop') {
        sendJson(response, 200, { session: stopSession(alertId) });
        return;
      }
      const input = await readBody(request);
      const agent = input && typeof input === 'object' && 'agent' in input ? input.agent : null;
      if (agent !== 'claude' && agent !== 'codex') {
        sendJson(response, 400, { error: 'Choose Claude or Codex.' });
        return;
      }
      const resumeCommand = input && typeof input === 'object' && 'resumeCommand' in input ? input.resumeCommand : undefined;
      const resumeId = typeof resumeCommand === 'string' ? codexResumeId(resumeCommand) : null;
      if (resumeCommand !== undefined && (agent !== 'codex' || !resumeId)) {
        sendJson(response, 400, { error: 'Enter a Codex session ID or a command like codex resume <id>.' });
        return;
      }
      const fresh = input && typeof input === 'object' && 'fresh' in input ? input.fresh : false;
      if (typeof fresh !== 'boolean' || (resumeId && fresh)) {
        sendJson(response, 400, { error: 'Invalid session options.' });
        return;
      }
      sendJson(response, 200, { session: startSession(alertId, agent as Agent, resumeId, fresh) });
      return;
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }
    if (url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true, channelId: CHANNEL_ID });
      return;
    }
    if (url.pathname === '/api/token') {
      sendJson(response, 200, { token: accessToken });
      return;
    }
    if (url.pathname === '/api/alerts') {
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!Number.isInteger(offset) || Math.abs(offset) > 12) {
        sendJson(response, 400, { error: 'Invalid shift offset.' });
        return;
      }
      sendJson(response, 200, await loadAlerts(offset, url.searchParams.get('refresh') === '1'));
      return;
    }
    if (sessionMatch) {
      sendJson(response, 200, { session: getSession(sessionMatch[1]) });
      return;
    }
    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    sendJson(response, 503, { error: message });
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);
  const match = url.pathname.match(/^\/api\/sessions\/((?:\d{10}\.\d{6}|jira-[A-Z][A-Z0-9]+-\d+))\/stream$/);
  if (
    !localHost(request.headers.host) ||
    !allowedOrigins.has(request.headers.origin || '') ||
    url.searchParams.get('token') !== accessToken ||
    !match || !hasSessionProcess(match[1])
  ) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (client) => attachSession(match[1], client));
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`MEP workbench API listening on http://127.0.0.1:${PORT}\n`);
});

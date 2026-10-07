import assert from 'node:assert/strict';
import test from 'node:test';
import { pagerDutyStatusFromThread } from './pagerduty';

const incidentUrl = 'https://abnormalsecurity.pagerduty.com/incidents/Q2MW1SVO7XWI7Z';
const root = { ts: '1790864269.171109', user_id: 'UC3V95762', text: `<${incidentUrl}|Incident>` };

test('the latest PagerDuty event determines the incident status', () => {
  const thread = { status: 'success', messages: [
    root,
    { ts: '1790866672.934469', user_id: 'UC3V95762', text: 'Resolved: Incident 695888 on dlp by Murtaza.' },
    { ts: '1790864346.767049', user_id: 'UC3V95762', text: 'Acknowledged: Incident 695888 on dlp by Murtaza.' },
    { ts: '1790867000.000000', user_id: 'UOTHER', text: 'Reopened: Incident 695888' },
  ] };
  const resolved = pagerDutyStatusFromThread(thread, root.ts, incidentUrl);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.updatedAt, new Date(1790866672.934469 * 1000).toISOString());

  thread.messages.push({ ts: '1790868000.000000', user_id: 'UC3V95762', text: 'Reopened: Incident 695888 on dlp.' });
  assert.equal(pagerDutyStatusFromThread(thread, root.ts, incidentUrl).status, 'triggered');
});

test('unverified or truncated threads never report a resolved incident', () => {
  const messages = [root, { ts: '1790866672.934469', user_id: 'UC3V95762', text: 'Resolved: Incident 695888 on dlp.' }];
  assert.equal(pagerDutyStatusFromThread({ status: 'success', messages, pagination: { has_more: true } }, root.ts, incidentUrl).status, 'unknown');
  assert.equal(pagerDutyStatusFromThread({ status: 'success', messages: [{ ...root, user_id: 'UOTHER' }, messages[1]] }, root.ts, incidentUrl).status, 'unknown');
  assert.equal(pagerDutyStatusFromThread({ status: 'success', messages: [root] }, root.ts, incidentUrl).status, 'unknown');
});

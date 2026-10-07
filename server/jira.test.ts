import assert from 'node:assert/strict';
import test from 'node:test';
import { initialJiraWorkflowStatus, parseActiveSprint, parseJiraIssues, ticketsWithoutAlertRoot } from './jira';

test('uses the one active MEP sprint and accepts older assigned work', () => {
  const sprint = parseActiveSprint([{ id: 27617, name: 'MEP FY 27 Q3 / 8', state: 'active', startDate: '2026-09-22', endDate: '2026-09-29' }]);
  assert.equal(sprint?.id, 27617);
  assert.deepEqual(parseJiraIssues([{ key: 'MEP-1479', summary: 'Older issue', status: 'To Do', type: 'Bug', updated: '2026-09-28' }]), [{
    key: 'MEP-1479', summary: 'Older issue', status: 'To Do', type: 'Bug', updated: '2026-09-28',
    url: 'https://abnormalsecurity.atlassian.net/browse/MEP-1479',
  }]);
});

test('fails closed when multiple active sprints or truncated issues make selection ambiguous', () => {
  assert.throws(() => parseActiveSprint([{ state: 'active' }, { state: 'active' }]), /multiple active/);
  assert.throws(() => parseJiraIssues(Array.from({ length: 500 }, () => ({}))), /incomplete/);
});

test('a linked Slack alert is the only queue root for its Jira ticket', () => {
  const issues = parseJiraIssues([
    { key: 'MEP-1726', summary: 'Linked follow-up', status: 'Blocked', updated: '2026-09-28' },
    { key: 'MEP-1725', summary: 'Unlinked follow-up', status: 'To Do', updated: '2026-09-28' },
  ]);
  const linkedAlert = { links: { jira: [{ reference: 'MEP-1726', status: 'Blocked', url: issues[0].url }], prs: [] } };
  assert.deepEqual(ticketsWithoutAlertRoot(issues, [linkedAlert]).map((issue) => issue.key), ['MEP-1725']);
  assert.deepEqual(ticketsWithoutAlertRoot(issues, []).map((issue) => issue.key), ['MEP-1726', 'MEP-1725']);
});

test('Jira status initializes the same workflow used by Slack items', () => {
  assert.equal(initialJiraWorkflowStatus('To Do'), 'todo');
  assert.equal(initialJiraWorkflowStatus('In Progress'), 'in_progress');
  assert.equal(initialJiraWorkflowStatus('Blocked'), 'backlog');
  assert.equal(initialJiraWorkflowStatus('Code Review / Pending Push'), 'review');
  assert.equal(initialJiraWorkflowStatus('Pending Deployment'), 'merge_deploy_pending');
  assert.equal(initialJiraWorkflowStatus('Done'), 'done');
});

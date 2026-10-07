import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLink } from './links';

test('normalizes Jira keys and source PR numbers', () => {
  assert.equal(normalizeLink('jira', 'mep-123'), 'MEP-123');
  assert.equal(normalizeLink('jira', 'https://abnormalsecurity.atlassian.net/browse/MEP-123'), 'MEP-123');
  assert.equal(normalizeLink('pr', '#456'), 'https://github.com/abnormal-security/source/pull/456');
  assert.equal(normalizeLink('pr', 'https://github.com/abnormal-security/infrastructure/pull/789'),
    'https://github.com/abnormal-security/infrastructure/pull/789');
});

test('rejects unrelated URLs and malformed references', () => {
  assert.equal(normalizeLink('jira', 'https://other.example/browse/MEP-123'), null);
  assert.equal(normalizeLink('pr', 'https://github.com/other-org/source/pull/456'), null);
  assert.equal(normalizeLink('pr', 'arbitrary shell text'), null);
});

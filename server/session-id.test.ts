import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexSessionIdFromOpenFiles } from './session-id';

const rollout = path.join(homedir(), '.codex', 'sessions', '2026', '09', '27', 'rollout-2026-09-27T18-50-16-01a0e306-019f-7f31-a9e8-eb5cc72f062f.jsonl');
const writerLock = path.join(homedir(), '.codex', 'thread-writer-locks', '01a0e32a-2eba-7cd0-85c4-8c35187aec55.lock');

test('extracts the Codex resume ID from this process’s open rollout file', () => {
  assert.equal(codexSessionIdFromOpenFiles(`p123\nn${rollout}\nn/dev/ttys053\n`), '01a0e306-019f-7f31-a9e8-eb5cc72f062f');
  assert.equal(codexSessionIdFromOpenFiles('p123\nn/dev/ttys053\n'), null);
  assert.equal(codexSessionIdFromOpenFiles(`p123\nn${rollout}\nn${rollout.replace('01a0e306-019f-7f31-a9e8-eb5cc72f062f', '01a0e30a-54ad-7c92-a426-e3afb42dc658')}\n`), null);
  assert.equal(codexSessionIdFromOpenFiles(`p123\nn${writerLock}\n`), '01a0e32a-2eba-7cd0-85c4-8c35187aec55');
  assert.equal(codexSessionIdFromOpenFiles(`p123\nn${writerLock}\nn${rollout}\n`), '01a0e32a-2eba-7cd0-85c4-8c35187aec55');
});

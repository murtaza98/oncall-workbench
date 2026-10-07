import assert from 'node:assert/strict';
import test from 'node:test';
import { codexResumeId } from '../shared/resume';

test('accepts a Codex ID or resume command without interpreting shell text', () => {
  const id = '01a0e32a-2eba-7cd0-85c4-8c35187aec55';
  assert.equal(codexResumeId(id), id);
  assert.equal(codexResumeId(` codex resume ${id} `), id);
  assert.equal(codexResumeId(`codex resume ${id}; rm -rf .`), null);
  assert.equal(codexResumeId('codex resume --last'), null);
  assert.equal(codexResumeId(''), null);
});

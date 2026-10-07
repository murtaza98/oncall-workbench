import assert from 'node:assert/strict';
import test from 'node:test';
import { screenNeedsInput } from '../src/terminal-attention';

test('identifies a Codex approval prompt without marking ordinary output', () => {
  assert.equal(screenNeedsInput('Would you like to run the following command?\n1. Yes, proceed (y)\n2. No (esc)'), true);
  assert.equal(screenNeedsInput('May I perform a narrow scoped production lookup? AGENTS.md requires confirmation.\nAsk Codex to do anything'), true);
  assert.equal(screenNeedsInput('Explored files\nWorking (10m 15s · esc to interrupt)\nAsk Codex to do anything'), false);
  assert.equal(screenNeedsInput('Would you like to run the following command?\n1. Yes, proceed\nWorking (2s · esc to interrupt)'), false);
});

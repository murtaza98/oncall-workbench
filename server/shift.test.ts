import assert from 'node:assert/strict';
import test from 'node:test';
import { shiftFor } from './shift';

test('uses Monday 11 am IST as the inclusive shift boundary', () => {
  const before = shiftFor(new Date('2026-09-28T05:29:59Z'));
  const at = shiftFor(new Date('2026-09-28T05:30:00Z'));

  assert.equal(before.start, '2026-09-21T05:30:00.000Z');
  assert.equal(before.end, at.start);
  assert.equal(at.start, '2026-09-28T05:30:00.000Z');
  assert.equal(at.end, '2026-10-05T05:30:00.000Z');
});

test('shift offset selects the upcoming week', () => {
  const shift = shiftFor(new Date('2026-09-26T10:00:00Z'), 1);
  assert.equal(shift.start, '2026-09-28T05:30:00.000Z');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotificationTitle } from './slack';

test('routine notifications are excluded without hiding alerts from the same senders', () => {
  assert.equal(isNotificationTitle('Internal Abnormal user changed outbound DLP config — 2 change(s)'), true);
  assert.equal(isNotificationTitle('Internal Abnormal user changed outbound DLP config — 1 change(s)'), true);
  for (const title of ['Client Map Sync Completed', 'DLQ Replay Complete', 'DLQ Replay Dry Run', 'MEP Enablement Succeeded', 'Outbound DLP Config Changed']) {
    assert.equal(isNotificationTitle(title), true);
  }
  assert.equal(isNotificationTitle('DLP DLQ Depth Growing'), false);
  assert.equal(isNotificationTitle('Tenant Permissions Validation Failures (SMTP Block Mode)'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { imageExtension } from './images';

test('accepts supported screenshot signatures and rejects other content', () => {
  assert.equal(imageExtension(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])), 'png');
  assert.equal(imageExtension(Buffer.from([255, 216, 255, 0])), 'jpg');
  assert.equal(imageExtension(Buffer.from('RIFF....WEBP', 'ascii')), 'webp');
  assert.equal(imageExtension(Buffer.from('<script>alert(1)</script>')), null);
  assert.equal(imageExtension(Buffer.alloc(0)), null);
});

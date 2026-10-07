import { chmodSync, statSync } from 'node:fs';
import path from 'node:path';

if (process.platform === 'darwin') {
  const helper = path.join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  const mode = statSync(helper).mode;
  chmodSync(helper, mode | 0o100);
}

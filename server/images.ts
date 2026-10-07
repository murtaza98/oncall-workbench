import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const imageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'attachments');

export class ImageUploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function imageExtension(bytes: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export async function saveUploadedImage(request: IncomingMessage): Promise<string> {
  if (Number(request.headers['content-length']) > MAX_IMAGE_BYTES) {
    throw new ImageUploadError('Screenshot exceeds the 10 MB limit.', 413);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_IMAGE_BYTES) throw new ImageUploadError('Screenshot exceeds the 10 MB limit.', 413);
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  const extension = imageExtension(bytes);
  if (!extension) throw new ImageUploadError('Paste a PNG, JPEG, or WebP image.', 415);

  await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(imageDirectory, `${randomUUID()}.${extension}`);
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  return file;
}

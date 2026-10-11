import { createServer } from 'node:http';
import { serverChunkSize } from 'yungle-e2e';
import { expect, test } from 'vitest';
import { uploadFile } from './upload';

test('a plain upload is sent in part-sized PATCHes, never as one request for the whole file', async () => {
  // Left at tus's default chunkSize of Infinity, a plain upload was ONE PATCH
  // for the whole file, so the proxy's 30-minute cap on a request body capped
  // the upload by line speed (the website's copy of this bug, 2026-10-11).
  const size = 33 * 1024 * 1024; // one byte-ful part past the 32 MiB boundary
  const patches: number[] = [];
  let offset = 0;
  const server = createServer((req, res) => {
    const tusHeaders = { 'tus-resumable': '1.0.0', 'access-control-expose-headers': 'location, upload-offset' };
    if (req.method === 'POST') {
      res.writeHead(201, { ...tusHeaders, location: '/files/file_1' }).end();
      return;
    }
    let n = 0;
    req.on('data', (c: Buffer) => (n += c.length));
    req.on('end', () => {
      patches.push(n);
      offset += n;
      res.writeHead(204, { ...tusHeaders, 'upload-offset': String(offset) }).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    await uploadFile(
      // A Buffer, which tus's Node build reads, carrying the `.size` a File has.
      Object.assign(Buffer.alloc(size), { size }) as unknown as File,
      { id: 'file_1', uploadToken: 'tok' },
      `http://127.0.0.1:${port}/files`,
      { onProgress: () => {} },
    );
  } finally {
    server.close();
  }
  expect(offset).toBe(size);
  expect(patches.length).toBeGreaterThanOrEqual(2);
  for (const n of patches) expect(n).toBeLessThanOrEqual(serverChunkSize(size));
}, 30_000);

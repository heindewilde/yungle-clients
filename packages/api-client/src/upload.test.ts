import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkSize, uploadFile, UploadError } from './upload';

const MiB = 1024 * 1024;

/** A tus server in a closure: commits whole 32 MiB parts, can drop a PATCH, records tokens. */
function fakeTus(opts: { dropFirstPatch?: boolean; refuse?: number } = {}) {
  let committed = 0;
  let dropped = false;
  const calls: { method: string; token: string | null; offset?: number }[] = [];
  const PART = 32 * MiB;
  const fetch = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method!, token: headers['x-yungle-upload-token'] ?? null, offset: Number(headers['Upload-Offset'] ?? NaN) });
    if (opts.refuse) return new Response(null, { status: opts.refuse });
    if (init.method === 'POST') return new Response(null, { status: 201, headers: { location: '/files/abc' } });
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'upload-offset': String(committed) } });
    const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
    const offset = Number(headers['Upload-Offset']);
    if (offset !== committed) return new Response(null, { status: 409 });
    if (opts.dropFirstPatch && !dropped) {
      dropped = true;
      committed += PART; // one part landed before the connection died
      throw new TypeError('fetch failed');
    }
    const end = offset + body.length;
    committed = end >= fakeTus.size ? end : Math.floor(end / PART) * PART;
    return new Response(null, { status: 204, headers: { 'upload-offset': String(committed) } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, committed: () => committed };
}
fakeTus.size = 0;

test('the chunk never drops below one server part', () => {
  assert.equal(chunkSize(10), 64 * MiB);
  assert.ok(chunkSize(1024 * 1024 * MiB) > 64 * MiB, 'a 1 TB file needs bigger chunks to stay under 9000 parts');
});

test('a dropped PATCH resumes from the committed offset, not from zero', async () => {
  fakeTus.size = 100 * MiB;
  const tus = fakeTus({ dropFirstPatch: true });
  const seen: number[] = [];
  const res = await uploadFile({
    endpoint: 'https://y.test/files',
    target: { id: 'f', name: 'a.bin', uploadToken: 't' },
    source: new Blob([new Uint8Array(fakeTus.size)]),
    fetch: tus.fetch,
    retryDelaysMs: [0, 0, 0],
    onProgress: (sent) => seen.push(sent),
  });
  assert.equal(res.uploadUrl, 'https://y.test/files/abc');
  assert.equal(tus.committed(), fakeTus.size);
  const patches = tus.calls.filter((c) => c.method === 'PATCH').map((c) => c.offset);
  assert.deepEqual(patches.slice(0, 2), [0, 32 * MiB], 'the second PATCH starts at the part that landed');
  assert.ok(tus.calls.some((c) => c.method === 'HEAD'), 'it asked the server where it was');
  assert.equal(seen.at(-1), fakeTus.size);
});

test('a hard refusal is not retried', async () => {
  fakeTus.size = 10;
  const tus = fakeTus({ refuse: 413 });
  await assert.rejects(
    uploadFile({ endpoint: 'https://y.test/files', target: { id: 'f', name: 'a', uploadToken: 't' }, source: new Blob(['0123456789']), fetch: tus.fetch, retryDelaysMs: [0, 0] }),
    (err) => err instanceof UploadError && err.status === 413,
  );
  assert.equal(tus.calls.length, 1);
});

test('resuming a stored upload URL HEADs instead of creating a second upload', async () => {
  fakeTus.size = 10;
  const tus = fakeTus();
  await uploadFile({
    endpoint: 'https://y.test/files',
    target: { id: 'f', name: 'a', uploadToken: 't' },
    source: new Blob(['0123456789']),
    uploadUrl: 'https://y.test/files/abc',
    fetch: tus.fetch,
  });
  assert.ok(!tus.calls.some((c) => c.method === 'POST'), 'never re-POSTs: that would restart with a new key');
});

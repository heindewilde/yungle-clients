import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DownloadLinks } from 'yungle-client';
import { safeRelative, saveLinks } from './download';

test('a sharer-chosen path can never leave the destination', () => {
  assert.equal(safeRelative('Raw/Day1', 'a.jpg'), 'Raw/Day1/a.jpg');
  assert.equal(safeRelative('../../.ssh', 'authorized_keys'), '.ssh/authorized_keys');
  assert.equal(safeRelative('', '../../etc/passwd'), 'passwd');
  assert.equal(safeRelative(undefined, '..'), 'file');
});

test('files land in their folders, resume a partial, and are skipped when already whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yungle-mcp-dl-'));
  const data = new TextEncoder().encode('0123456789'.repeat(50));
  const ranges: (string | null)[] = [];
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    ranges.push(range);
    const start = range ? Number(range.slice(6, -1)) : 0;
    return new Response(data.slice(start), { status: range ? 206 : 200 });
  }) as typeof fetch;
  const links = {
    kind: 'collection',
    title: 't',
    message: null,
    expiresAt: null,
    e2ee: false,
    complete: true,
    zipUrl: null,
    urlsExpireAt: '',
    files: [
      { id: '1', name: 'a.bin', size: data.length, mimeType: 'x', path: 'Raw', downloadUrl: 'http://h/1' },
      { id: '2', name: 'a.bin', size: data.length, mimeType: 'x', path: 'Raw', downloadUrl: 'http://h/2' },
    ],
  } satisfies DownloadLinks;
  await mkdir(join(dir, 'Raw'));
  await writeFile(join(dir, 'Raw/a.bin.part'), data.slice(0, 120));

  const saved = await saveLinks(links, dir, fakeFetch);
  assert.deepEqual(saved.map((s) => s.path.slice(dir.length + 1)), ['Raw/a.bin', 'Raw/a (2).bin']);
  assert.deepEqual(new Uint8Array(await readFile(join(dir, 'Raw/a.bin'))), data);
  assert.equal(ranges[0], 'bytes=120-');
  assert.deepEqual((await readdir(join(dir, 'Raw'))).sort(), ['a (2).bin', 'a.bin']);

  ranges.length = 0;
  const again = await saveLinks(links, dir, fakeFetch);
  assert.ok(again.every((s) => s.skipped));
  assert.equal(ranges.length, 0);
});

test('a file whose checksum does not match is deleted, not kept under its name', async () => {
  const { crc32 } = await import('node:zlib');
  const dir = await mkdtemp(join(tmpdir(), 'yungle-mcp-crc-'));
  const data = new TextEncoder().encode('payload');
  const fakeFetch = (async () => new Response(data)) as typeof fetch;
  const base = { kind: 'transfer', title: null, message: null, expiresAt: null, e2ee: false, complete: true, zipUrl: null, urlsExpireAt: '' } as const;
  const good = crc32(data).toString(16).padStart(8, '0');
  await saveLinks({ ...base, files: [{ id: '1', name: 'ok.txt', size: data.length, mimeType: 'x', path: '', downloadUrl: 'http://h/1', crc32: good }] }, dir, fakeFetch);
  await assert.rejects(
    saveLinks({ ...base, files: [{ id: '2', name: 'bad.txt', size: data.length, mimeType: 'x', path: '', downloadUrl: 'http://h/2', crc32: 'deadbeef' }] }, dir, fakeFetch),
    /damaged/,
  );
  assert.deepEqual((await readdir(dir)).sort(), ['ok.txt']);
});

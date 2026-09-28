import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  base64UrlDecode,
  base64UrlEncode,
  decodeKeyFragment,
  deriveMetaKey,
  encodeKeyFragment,
  generateMasterBytes,
  importMaster,
} from './keys';
import { fileMetaInfo, openJson, sealJson, type SealedFileMeta } from './meta';

test('the key fragment round-trips', () => {
  const raw = generateMasterBytes();
  const fragment = encodeKeyFragment(raw);
  assert.match(fragment, /^k1\.[A-Za-z0-9_-]+$/);
  // 32 bytes of base64url, unpadded.
  assert.equal(fragment.length, 3 + 43);
  assert.deepEqual(decodeKeyFragment(fragment), raw);
  assert.deepEqual(decodeKeyFragment('#' + fragment), raw, 'tolerates a leading #');
});

test('the fragment fails closed on anything it does not recognise', () => {
  const raw = generateMasterBytes();

  assert.equal(decodeKeyFragment(''), null);
  assert.equal(decodeKeyFragment('#'), null);
  // A future scheme must not be read by this code as if it were k1.
  assert.equal(decodeKeyFragment('k2.' + base64UrlEncode(raw)), null);
  // No prefix at all — an old-style bare fragment.
  assert.equal(decodeKeyFragment(base64UrlEncode(raw)), null);
  // Right shape, wrong length.
  assert.equal(decodeKeyFragment('k1.' + base64UrlEncode(raw.subarray(0, 16))), null);
  assert.equal(decodeKeyFragment('k1.!!!not base64!!!'), null);
});

test('base64url survives bytes that trip padding and the +/ alphabet', () => {
  for (const len of [0, 1, 2, 3, 31, 32, 33, 64]) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    assert.deepEqual(base64UrlDecode(base64UrlEncode(bytes)), bytes, `len=${len}`);
  }
  const alphabet = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(base64UrlDecode(base64UrlEncode(alphabet)), alphabet);
  assert.doesNotMatch(base64UrlEncode(alphabet), /[+/=]/);
});

test('filenames seal and open under the metadata key', async () => {
  const master = await importMaster(generateMasterBytes());
  const key = await deriveMetaKey(master);

  const meta: SealedFileMeta = {
    name: 'Q3 — final (v2).pdf',
    path: 'Board/2026',
    size: 1234567,
    type: 'application/pdf',
  };
  const blob = await sealJson(key, meta, fileMetaInfo('file-1'));
  assert.deepEqual(await openJson<SealedFileMeta>(key, blob, fileMetaInfo('file-1')), meta);
});

test('a sealed name cannot be replayed onto another file', async () => {
  // The server holds every one of these rows and could shuffle them between
  // files. Binding the file id as AAD is what stops that.
  const master = await importMaster(generateMasterBytes());
  const key = await deriveMetaKey(master);
  const blob = await sealJson(key, { name: 'a.txt', size: 1, type: 'text/plain' }, fileMetaInfo('file-1'));

  await assert.rejects(() => openJson(key, blob, fileMetaInfo('file-2')));
});

test('another transfer key cannot read this transfer metadata', async () => {
  const mine = await deriveMetaKey(await importMaster(generateMasterBytes()));
  const theirs = await deriveMetaKey(await importMaster(generateMasterBytes()));
  const blob = await sealJson(mine, { name: 'secret.txt', size: 1, type: 'text/plain' }, fileMetaInfo('f'));
  await assert.rejects(() => openJson(theirs, blob, fileMetaInfo('f')));
});

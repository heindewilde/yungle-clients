import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { test } from 'node:test';

import {
  HEADER_LEN,
  MAGIC,
  TAG_LEN,
  buildHeader,
  e2eCiphertextSize,
  openSegment,
  readHeader,
  sealSegment,
  sealedLengthOf,
  sealedOffsetOf,
  segmentAtOffset,
  segmentCount,
  type Bytes,
} from './format';

const RAW_KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
const PREFIX = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);

const importAes = (raw: Bytes) =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

/**
 * An independent implementation of the same format, written against Node's
 * `crypto` rather than WebCrypto.
 *
 * The point is not coverage, it is disagreement: a bug in the WebCrypto code
 * that also existed in a test written from the same mental model would pass
 * either way. Two APIs, two code paths, one expected byte string. A mismatch
 * here means files that cannot be opened, so this is the gate.
 */
function oracleSeal(key: Uint8Array, header: Uint8Array, index: number, plain: Uint8Array) {
  const nonce = Buffer.alloc(12);
  Buffer.from(header.subarray(8, 12)).copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(index), 4);

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(index));
  const aad = Buffer.concat([Buffer.from(header), counter]);

  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function oracleOpen(key: Uint8Array, header: Uint8Array, index: number, sealed: Uint8Array) {
  const nonce = Buffer.alloc(12);
  Buffer.from(header.subarray(8, 12)).copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(index), 4);

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(index));

  const body = Buffer.from(sealed.subarray(0, sealed.length - TAG_LEN));
  const tag = Buffer.from(sealed.subarray(sealed.length - TAG_LEN));
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.concat([Buffer.from(header), counter]));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

test('header round-trips', () => {
  const h = buildHeader({ noncePrefix: PREFIX, plainLen: 123456789, segmentSize: 1024 });
  assert.equal(h.length, HEADER_LEN);
  assert.deepEqual(h.subarray(0, 4), MAGIC);

  const parsed = readHeader(h);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.segmentSize, 1024);
  assert.equal(parsed.plainLen, 123456789);
  assert.deepEqual(parsed.noncePrefix, PREFIX);
});

test('header rejects foreign or future objects', () => {
  const h = buildHeader({ noncePrefix: PREFIX, plainLen: 10 });
  const notOurs = h.slice();
  notOurs[0] = 0x00;
  assert.throws(() => readHeader(notOurs), /not a Yungle end-to-end/);

  const future = h.slice();
  future[4] = 2;
  assert.throws(() => readHeader(future), /unsupported e2e format version 2/);

  assert.throws(() => readHeader(h.subarray(0, 8)), /truncated/);
});

test('ciphertext size is header + plaintext + one tag per segment', () => {
  const S = 1024;
  const cases: [number, number][] = [
    [0, HEADER_LEN],
    [1, HEADER_LEN + 1 + TAG_LEN],
    [S - 1, HEADER_LEN + S - 1 + TAG_LEN],
    [S, HEADER_LEN + S + TAG_LEN],
    [S + 1, HEADER_LEN + S + 1 + 2 * TAG_LEN],
    [4 * S, HEADER_LEN + 4 * S + 4 * TAG_LEN],
  ];
  for (const [plain, expected] of cases) {
    assert.equal(e2eCiphertextSize(plain, S), expected, `plainLen=${plain}`);
  }
  // A 5 GB file at the real 1 MiB segment size — the arithmetic that decides
  // what `files.size_bytes` is set to, so worth pinning at production scale.
  const fiveGb = 5 * 1024 ** 3;
  assert.equal(e2eCiphertextSize(fiveGb), HEADER_LEN + fiveGb + 5120 * TAG_LEN);
});

test('segment offset arithmetic locates every byte of the object', () => {
  const S = 1024;
  const plainLen = 3 * S + 17;
  assert.equal(segmentCount(plainLen, S), 4);

  for (let i = 0; i < 4; i++) {
    const start = sealedOffsetOf(i, S);
    const len = sealedLengthOf(i, plainLen, S);
    // Every byte of this segment must map back to it.
    assert.equal(segmentAtOffset(start, S), i, `start of segment ${i}`);
    assert.equal(segmentAtOffset(start + len - 1, S), i, `end of segment ${i}`);
  }
  assert.equal(sealedLengthOf(3, plainLen, S), 17 + TAG_LEN, 'last segment is short');
  // The whole object is exactly the segments plus the header.
  assert.equal(sealedOffsetOf(3, S) + sealedLengthOf(3, plainLen, S), e2eCiphertextSize(plainLen, S));
});

test('WebCrypto and Node agree byte-for-byte on the sealed format', async () => {
  const key = await importAes(RAW_KEY);
  const header = buildHeader({ noncePrefix: PREFIX, plainLen: 5000, segmentSize: 1024 });

  for (const index of [0, 1, 7, 1000]) {
    const plain = Uint8Array.from({ length: 1024 }, (_, i) => (i + index) % 251);

    const ours = await sealSegment(key, header, index, plain);
    const theirs = oracleSeal(RAW_KEY, header, index, plain);
    assert.deepEqual(Buffer.from(ours), theirs, `seal disagreed at segment ${index}`);

    // …and each can open what the other sealed.
    assert.deepEqual(Buffer.from(await openSegment(key, header, index, theirs)), Buffer.from(plain));
    assert.deepEqual(oracleOpen(RAW_KEY, header, index, ours), Buffer.from(plain));
  }
});

test('a segment will not open at the wrong index', async () => {
  const key = await importAes(RAW_KEY);
  const header = buildHeader({ noncePrefix: PREFIX, plainLen: 2048, segmentSize: 1024 });
  const sealed = await sealSegment(key, header, 0, new Uint8Array(1024).fill(9));
  await assert.rejects(() => openSegment(key, header, 1, sealed));
});

test('a segment will not open under a tampered header', async () => {
  const key = await importAes(RAW_KEY);
  const header = buildHeader({ noncePrefix: PREFIX, plainLen: 2048, segmentSize: 1024 });
  const sealed = await sealSegment(key, header, 0, new Uint8Array(1024).fill(3));

  // The server stores the header in the clear and could edit it. Shrinking the
  // declared plaintext length is the interesting attack: without the AAD
  // binding it would silently truncate the file the recipient gets.
  const lying = header.slice();
  new DataView(lying.buffer).setBigUint64(12, 1024n);
  await assert.rejects(() => openSegment(key, lying, 0, sealed));

  const movedPrefix = header.slice();
  movedPrefix[8] = movedPrefix[8]! ^ 0xff;
  await assert.rejects(() => openSegment(key, movedPrefix, 0, sealed));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEADER_LEN, TAG_LEN, e2eCiphertextSize } from './format';
import { deriveFileMaterial, generateMasterBytes, importMaster } from './keys';
import { openCiphertextBytes } from './open';
import { createCiphertextSource, createE2eFileReader, type SliceableBlob } from './source';

/** A `Blob`-shaped view over bytes, so this runs under `node --test`. */
function blobOf(bytes: Uint8Array): SliceableBlob {
  return {
    size: bytes.length,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => {
        const s = bytes.slice(start, end);
        return s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) as ArrayBuffer;
      },
    }),
  };
}

/** Small segments keep these fast while exercising identical arithmetic. */
const S = 1024;

async function material(fileId = 'file-1') {
  const master = await importMaster(generateMasterBytes());
  return deriveFileMaterial(master, fileId);
}

async function fullCiphertext(bytes: Uint8Array, mat: Awaited<ReturnType<typeof material>>) {
  const src = createCiphertextSource(blobOf(bytes), { ...mat, segmentSize: S });
  const { value, done } = await src.slice(0, src.size);
  assert.equal(done, true);
  assert.equal(value.length, src.size);
  return value;
}

const SIZES = [0, 1, 100, S - 1, S, S + 1, 2 * S, 3 * S + 17, 10 * S];

test('every file size round-trips exactly', async () => {
  const mat = await material();
  for (const size of SIZES) {
    const plain = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 256);
    const ct = await fullCiphertext(plain, mat);

    assert.equal(ct.length, e2eCiphertextSize(size, S), `ciphertext size for ${size}`);
    const opened = await openCiphertextBytes(ct, mat);
    assert.deepEqual(Buffer.from(opened), Buffer.from(plain), `round-trip for ${size}`);
  }
});

test('slicing in any pattern reproduces the whole ciphertext', async () => {
  const mat = await material();
  const size = 7 * S + 331;
  const plain = Uint8Array.from({ length: size }, (_, i) => (i * 17) % 256);
  const whole = await fullCiphertext(plain, mat);

  // Chunk sizes chosen to land on and between every interesting boundary:
  // inside the header, exactly a sealed segment, one byte either side of one,
  // and a prime that drifts across boundaries every time.
  const sealed = S + TAG_LEN;
  for (const step of [1, 7, HEADER_LEN, HEADER_LEN + 1, sealed - 1, sealed, sealed + 1, 997]) {
    const src = createCiphertextSource(blobOf(plain), { ...mat, segmentSize: S });
    const parts: Uint8Array[] = [];
    for (let at = 0; at < src.size; at += step) {
      const { value } = await src.slice(at, Math.min(at + step, src.size));
      parts.push(value);
    }
    const joined = Buffer.concat(parts.map((p) => Buffer.from(p)));
    assert.deepEqual(joined, Buffer.from(whole), `step=${step}`);
  }
});

test('resuming from an arbitrary offset produces the bytes that continue the object', async () => {
  // This is the property tus depends on. After a dropped connection the client
  // HEADs, gets the server's committed offset — part-aligned, and not aligned
  // to anything the client knows about — and must send bytes that continue what
  // is already in S3. Deterministic sealing is what makes that true.
  const mat = await material();
  const size = 9 * S + 5;
  const plain = Uint8Array.from({ length: size }, (_, i) => (i * 13 + 3) % 256);
  const whole = await fullCiphertext(plain, mat);

  const offsets = [0, 1, HEADER_LEN, HEADER_LEN + 1, S, S + TAG_LEN, 3 * (S + TAG_LEN) + 9, whole.length - 1];
  for (const at of offsets) {
    const src = createCiphertextSource(blobOf(plain), { ...mat, segmentSize: S });
    const { value } = await src.slice(at, src.size);
    assert.deepEqual(
      Buffer.from(value),
      Buffer.from(whole.subarray(at)),
      `resume from ${at}`,
    );
  }
});

test('the same file sealed twice is byte-identical', async () => {
  // If it were not, a resumed upload would splice two different ciphertexts
  // together and the file would be silently unopenable.
  const mat = await material();
  const plain = Uint8Array.from({ length: 4 * S + 11 }, (_, i) => i % 256);
  const a = await fullCiphertext(plain, mat);
  const b = await fullCiphertext(plain, mat);
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

test('different files get different keys and nonce prefixes from one master', async () => {
  const master = await importMaster(generateMasterBytes());
  const one = await deriveFileMaterial(master, 'file-1');
  const two = await deriveFileMaterial(master, 'file-2');
  assert.notDeepEqual(one.noncePrefix, two.noncePrefix);

  const plain = Uint8Array.from({ length: 200 }, (_, i) => i);
  const ct = await fullCiphertext(plain, one);
  // The other file's key must not open it.
  await assert.rejects(() => openCiphertextBytes(ct, two));

  // …and derivation is deterministic, or resume breaks.
  const again = await deriveFileMaterial(master, 'file-1');
  assert.deepEqual(again.noncePrefix, one.noncePrefix);
});

test('truncation and reordering are both caught', async () => {
  const mat = await material();
  const plain = Uint8Array.from({ length: 3 * S }, (_, i) => i % 256);
  const whole = await fullCiphertext(plain, mat);
  const sealed = S + TAG_LEN;

  // Drop the last segment. Per-segment tags cannot see this — the length check
  // against the authenticated header is what catches it.
  await assert.rejects(
    () => openCiphertextBytes(whole.subarray(0, whole.length - sealed), mat),
    /length mismatch/,
  );

  // Swap segments 0 and 1.
  const swapped = whole.slice();
  const first = whole.subarray(HEADER_LEN, HEADER_LEN + sealed);
  const second = whole.subarray(HEADER_LEN + sealed, HEADER_LEN + 2 * sealed);
  swapped.set(second, HEADER_LEN);
  swapped.set(first, HEADER_LEN + sealed);
  await assert.rejects(() => openCiphertextBytes(swapped, mat));

  // Flip one byte of payload.
  const bitrot = whole.slice();
  bitrot[HEADER_LEN + 40] = bitrot[HEADER_LEN + 40]! ^ 0x01;
  await assert.rejects(() => openCiphertextBytes(bitrot, mat));
});

test('what tus-js-client receives has a .size it can read', async () => {
  // This is the bug that shipped: tus advances its offset with
  // `value?.size ? value.size : 0`. A Uint8Array has `.length` and
  // `.byteLength` but NOT `.size`, so tus concluded zero bytes were sent on
  // every chunk, never progressed, and retried until it failed — while the
  // server accepted every byte. It surfaced to users as a connection error
  // with no connection problem, which is why it was hard to read.
  const mat = await material();
  const plain = Uint8Array.from({ length: 3 * S + 40 }, (_, i) => i % 256);
  const reader = createE2eFileReader({ ...mat, segmentSize: S });
  const src = await reader.openFile(blobOf(plain));

  const { value, done } = await src.slice(0, 100);
  assert.equal(typeof value.size, 'number', 'tus reads `.size`; it must exist');
  assert.equal(value.size, 100, 'and it must be the real byte count, not 0');
  assert.equal(done, false);

  // The bytes must still be the same ones the raw source produces.
  const raw = createCiphertextSource(blobOf(plain), { ...mat, segmentSize: S });
  const expected = (await raw.slice(0, 100)).value;
  assert.deepEqual(Buffer.from(value), Buffer.from(expected), 'wrapping must not change the ciphertext');
  // It must still BE bytes: tus's Node stack rejects a Blob outright, and the
  // browser's XHR needs an ArrayBufferView or a Blob. A Uint8Array carrying
  // `size` is the one shape both accept.
  assert.ok(value instanceof Uint8Array, 'still a Uint8Array, so both http stacks accept it');

  const tail = await src.slice(0, src.size);
  assert.equal(tail.done, true, 'done flips at the end so tus stops asking');
  assert.equal(tail.value.size, src.size);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { e2eCiphertextSize } from './format';
import { deriveFileMaterial, generateMasterBytes, importMaster } from './keys';
import { openCiphertextBytes } from './open';
import { createVaultRelaySource, type RangeFetcher } from './relay';
import { createCiphertextSource, type SliceableBlob } from './source';

const S = 1024;

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

/** Stands in for `/dl/:id` with a Range header. Counts what it was asked for. */
function fetcherOver(stored: Uint8Array, log: Array<[number, number]> = []): RangeFetcher {
  return async (start, endInclusive) => {
    log.push([start, endInclusive]);
    return stored.slice(start, endInclusive + 1);
  };
}

/** Put a file in "the vault": seal it under a vault key, as an upload would. */
async function storeInVault(plain: Uint8Array, fileId = 'vault-file') {
  const master = await importMaster(generateMasterBytes());
  const material = await deriveFileMaterial(master, fileId);
  const src = createCiphertextSource(blobOf(plain), { ...material, segmentSize: S });
  const stored = (await src.slice(0, src.size)).value;
  return { master, material, stored };
}

test('a vault file re-keys into a transfer without ever being held whole', async () => {
  const plain = Uint8Array.from({ length: 5 * S + 411 }, (_, i) => (i * 29 + 5) % 256);
  const vault = await storeInVault(plain);

  const transferMaster = await importMaster(generateMasterBytes());
  const target = await deriveFileMaterial(transferMaster, 'transfer-file');

  const relay = createVaultRelaySource({
    source: { ...vault.material, segmentSize: S },
    target: { ...target, segmentSize: S },
    plainLen: plain.length,
    fetchRange: fetcherOver(vault.stored),
  });

  assert.equal(relay.size, e2eCiphertextSize(plain.length, S), 'declares the right upload size');

  const uploaded = (await relay.slice(0, relay.size)).value;
  const opened = await openCiphertextBytes(uploaded, target);
  assert.deepEqual(
    Buffer.from(opened),
    Buffer.from(plain),
    'the recipient key opens it back to the original file',
  );

  // The vault key must NOT open the transfer copy: it was re-keyed, not copied.
  await assert.rejects(() => openCiphertextBytes(uploaded, vault.material));
});

test('slicing the relay in any pattern gives the same upload', async () => {
  // The property tus resume depends on, now across two layers of encryption.
  const plain = Uint8Array.from({ length: 4 * S + 77 }, (_, i) => (i * 13) % 256);
  const vault = await storeInVault(plain);
  const target = await deriveFileMaterial(await importMaster(generateMasterBytes()), 'tf');

  const mk = () =>
    createVaultRelaySource({
      source: { ...vault.material, segmentSize: S },
      target: { ...target, segmentSize: S },
      plainLen: plain.length,
      fetchRange: fetcherOver(vault.stored),
    });

  const whole = (await mk().slice(0, mk().size)).value;

  for (const step of [1, 97, S, S + 16, 1500]) {
    const src = mk();
    const parts: Uint8Array[] = [];
    for (let at = 0; at < src.size; at += step) {
      parts.push((await src.slice(at, Math.min(at + step, src.size))).value);
    }
    assert.deepEqual(
      Buffer.concat(parts.map((p) => Buffer.from(p))),
      Buffer.from(whole),
      `step=${step}`,
    );
  }
});

test('resuming from an arbitrary offset continues the same upload', async () => {
  const plain = Uint8Array.from({ length: 6 * S + 5 }, (_, i) => i % 256);
  const vault = await storeInVault(plain);
  const target = await deriveFileMaterial(await importMaster(generateMasterBytes()), 'tf');

  const mk = () =>
    createVaultRelaySource({
      source: { ...vault.material, segmentSize: S },
      target: { ...target, segmentSize: S },
      plainLen: plain.length,
      fetchRange: fetcherOver(vault.stored),
    });

  const whole = (await mk().slice(0, mk().size)).value;
  for (const at of [0, 20, S, 3 * (S + 16) + 7, whole.length - 1]) {
    const tail = (await mk().slice(at, mk().size)).value;
    assert.deepEqual(Buffer.from(tail), Buffer.from(whole.subarray(at)), `resume from ${at}`);
  }
});

test('it fetches only the segments a window touches', async () => {
  // The whole point: a 5 GB send must not pull 5 GB per slice.
  const plain = Uint8Array.from({ length: 20 * S }, (_, i) => i % 256);
  const vault = await storeInVault(plain);
  const target = await deriveFileMaterial(await importMaster(generateMasterBytes()), 'tf');

  const log: Array<[number, number]> = [];
  const relay = createVaultRelaySource({
    source: { ...vault.material, segmentSize: S },
    target: { ...target, segmentSize: S },
    plainLen: plain.length,
    fetchRange: fetcherOver(vault.stored, log),
  });

  // One chunk's worth, from the middle.
  await relay.slice(5 * (S + 16), 6 * (S + 16));
  const fetched = log
    .filter(([s, e]) => e - s > 64) // ignore the tiny header verification read
    .reduce((n, [s, e]) => n + (e - s + 1), 0);

  assert.ok(
    fetched < 4 * (S + 16),
    `pulled ${fetched} bytes for a ~1 KB window — it should be a couple of segments`,
  );
});

test('a mismatched length is refused rather than silently truncated', async () => {
  const plain = Uint8Array.from({ length: 3 * S }, (_, i) => i % 256);
  const vault = await storeInVault(plain);
  const target = await deriveFileMaterial(await importMaster(generateMasterBytes()), 'tf');

  const relay = createVaultRelaySource({
    source: { ...vault.material, segmentSize: S },
    target: { ...target, segmentSize: S },
    // The metadata says something the stored header disagrees with.
    plainLen: plain.length - 100,
    fetchRange: fetcherOver(vault.stored),
  });

  await assert.rejects(() => relay.slice(0, relay.size), /length does not match/);
});

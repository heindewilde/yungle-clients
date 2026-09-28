/**
 * Re-keying one encrypted file into another, without ever holding it.
 *
 * This is what "send a file from my Vault" needs. The server holds neither
 * key, so the bytes must pass through the browser: fetch the vault ciphertext,
 * open it with the vault key, seal it under a fresh transfer key, upload. The
 * naive version buffers the whole file, which caps the feature at whatever the
 * tab can hold.
 *
 * It streams instead, and the reason it can is that both halves of the journey
 * are the same segmented format. A requested window of *transfer* ciphertext
 * maps to a run of plaintext segments, which maps to a run of *vault*
 * ciphertext segments, which is one HTTP Range request — `resolveFileDownload`
 * already serves ranged reads via `planRangedRead`. So `slice()` stays a pure
 * function of its offsets, which is exactly the property tus needs: a
 * send-from-vault upload resumes after a dropped connection like any other.
 *
 * The cost is bandwidth and patience, not memory: sending 5 GB means pulling
 * 5 GB down and pushing 5 GB up with the tab open.
 */

import {
  HEADER_LEN,
  SEGMENT_SIZE,
  TAG_LEN,
  buildHeader,
  openSegment,
  readHeader,
  sealedLengthOf,
  sealedOffsetOf,
  type Bytes,
} from './format';
import { createCiphertextSource, type CiphertextSourceInit, type E2eFileSource } from './source';

/** Fetches a byte range of the stored vault ciphertext. */
export type RangeFetcher = (start: number, endInclusive: number) => Promise<Bytes>;

export interface VaultSourceInit {
  /** Opens the vault copy. */
  source: { key: CryptoKey; noncePrefix: Bytes; segmentSize?: number };
  /** Seals the transfer copy. */
  target: CiphertextSourceInit;
  /** Plaintext length of the file. Known from the vault's sealed metadata. */
  plainLen: number;
  fetchRange: RangeFetcher;
}

/**
 * A `Blob`-shaped view whose bytes are the *decrypted* vault file.
 *
 * `createCiphertextSource` only needs `size` and `slice(start,end).arrayBuffer()`,
 * so presenting the decrypted file as one of these lets the existing sealing
 * path work unchanged — the re-keying is a composition, not a second
 * implementation of the format.
 */
function decryptedView(init: VaultSourceInit) {
  const segmentSize = init.source.segmentSize ?? SEGMENT_SIZE;
  const header = buildHeader({
    noncePrefix: init.source.noncePrefix,
    plainLen: init.plainLen,
    segmentSize,
  });
  // The stored header must match what we derived, or the key is wrong for this
  // file — checked once, lazily, on the first read.
  let verified = false;

  return {
    size: init.plainLen,
    slice(start: number, end: number) {
      return {
        async arrayBuffer(): Promise<ArrayBuffer> {
          const from = Math.max(0, Math.min(start, init.plainLen));
          const to = Math.max(from, Math.min(end, init.plainLen));
          if (to === from) return new ArrayBuffer(0);

          if (!verified) {
            const stored = await init.fetchRange(0, HEADER_LEN - 1);
            const parsed = readHeader(stored);
            if (parsed.plainLen !== init.plainLen) {
              throw new Error('vault file length does not match its metadata');
            }
            verified = true;
          }

          const first = Math.floor(from / segmentSize);
          const last = Math.floor((to - 1) / segmentSize);

          // One request covering every segment the window touches.
          const rangeStart = sealedOffsetOf(first, segmentSize);
          const rangeEnd =
            sealedOffsetOf(last, segmentSize) + sealedLengthOf(last, init.plainLen, segmentSize) - 1;
          const sealed = await init.fetchRange(rangeStart, rangeEnd);

          const out = new Uint8Array(to - from);
          let written = 0;
          for (let i = first; i <= last; i++) {
            const offset = sealedOffsetOf(i, segmentSize) - rangeStart;
            const len = sealedLengthOf(i, init.plainLen, segmentSize);
            const plain = await openSegment(
              init.source.key,
              header,
              i,
              sealed.subarray(offset, offset + len),
            );
            // Trim this segment to the part of the window it contributes.
            const segStart = i * segmentSize;
            const takeFrom = Math.max(0, from - segStart);
            const takeTo = Math.min(plain.length, to - segStart);
            out.set(plain.subarray(takeFrom, takeTo), written);
            written += takeTo - takeFrom;
          }
          return out.buffer.slice(0, written) as ArrayBuffer;
        },
      };
    },
  };
}

/**
 * A tus source that reads from the vault and writes under a new key.
 *
 * Deterministic end to end — the same offsets always produce the same bytes —
 * so resume works exactly as it does for an ordinary encrypted upload.
 */
export function createVaultRelaySource(init: VaultSourceInit): E2eFileSource {
  return createCiphertextSource(decryptedView(init), init.target);
}

/** Builds a `RangeFetcher` over a signed `/dl/:id` URL. */
export function httpRangeFetcher(url: string): RangeFetcher {
  return async (start, endInclusive) => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
    // 206 is the expected answer; a 200 means the server ignored the Range and
    // sent everything, which would silently misalign every offset below.
    if (res.status !== 206) {
      throw new Error(`expected a ranged response, got ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };
}

export { TAG_LEN };

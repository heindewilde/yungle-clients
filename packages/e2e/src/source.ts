/**
 * A seekable view of a file's ciphertext, without ever holding it in memory.
 *
 * This is what makes end-to-end encryption compatible with resumable uploads.
 * tus-js-client (v4) lets you supply `options.fileReader`, an object with
 * `openFile(input, chunkSize)` returning a source it can `slice(start, end)`.
 * Normally that just slices a `File`. Here it slices a file that does not exist
 * yet: `slice()` works out which plaintext segments cover the requested
 * ciphertext window, reads exactly those from disk, seals them, and returns the
 * requested bytes.
 *
 * Because the format is deterministic — same key, same derived nonce prefix,
 * same header, same segment boundaries — asking for the same range twice
 * returns the same bytes. That is the property the whole thing rests on: after
 * a dropped connection tus HEADs for the server's committed offset (part-
 * aligned, 32 MiB granularity) and resumes from there, and the bytes it sends
 * continue the ones already in S3 exactly.
 *
 * A `chunkSize` MUST be configured on the upload. With the default of Infinity
 * tus would ask for `slice(0, Infinity)` and we would seal the entire file into
 * one buffer, which for the 100 GB case this product exists to serve is not a
 * subtle problem. Use {@link serverChunkSize} — and read why it is not just a
 * constant before changing it.
 */

import {
  HEADER_LEN,
  SEGMENT_SIZE,
  TAG_LEN,
  buildHeader,
  e2eCiphertextSize,
  sealSegment,
  sealedLengthOf,
  sealedOffsetOf,
  segmentAtOffset,
  segmentCount,
  type Bytes,
} from './format';

/**
 * How much ciphertext tus may send per PATCH — and it is not a free choice.
 *
 * `EncryptingTusStore.write()` answers a partial PATCH with
 * `writer.committedOffset`, which only advances at S3 *part* boundaries; its
 * own comment says "the mid-part tail is re-sent on the next PATCH". So a
 * client that PATCHes less than one part gets `Upload-Offset: 0` back,
 * re-slices from 0, sends the same bytes, and loops forever. Nothing today
 * sets `chunkSize`, so nothing has ever hit it — but E2E uploads MUST set one
 * (the default is Infinity, which would seal the whole file into one Blob).
 *
 * This mirrors `planParts()` in `@yungle/pipeline/resumable`, against which it
 * is cross-checked in the tests. Note the part size is *not* always 32 MiB:
 * past ~288 GB the 9000-part ceiling forces it up, and a hardcoded constant
 * would wedge exactly the largest uploads.
 *
 * `ciphertextSize` is what we upload, which is what the server calls plaintext.
 */
const SERVER_SEGMENT_SIZE = 1 << 20;
const SERVER_TARGET_PART_BYTES = 32 * 1024 * 1024;
const SERVER_MAX_PARTS = 9000;

export function serverChunkSize(ciphertextSize: number): number {
  const sealedSegment = SERVER_SEGMENT_SIZE + TAG_LEN;
  const byTarget = Math.max(1, Math.round(SERVER_TARGET_PART_BYTES / sealedSegment));
  const totalSegments = Math.max(1, Math.ceil(ciphertextSize / SERVER_SEGMENT_SIZE));
  const byCount = Math.ceil(totalSegments / SERVER_MAX_PARTS);
  return Math.max(byTarget, byCount) * SERVER_SEGMENT_SIZE;
}

/** The shape tus-js-client's `fileReader` contract expects. */
export interface E2eFileSource {
  size: number;
  slice(start: number, end: number): Promise<{ value: Bytes; done: boolean }>;
  close(): void;
}

export interface CiphertextSourceInit {
  key: CryptoKey;
  noncePrefix: Bytes;
  segmentSize?: number;
}

/** Minimal slice of the `Blob`/`File` API we rely on — keeps this testable in Node. */
export interface SliceableBlob {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export function createCiphertextSource(
  file: SliceableBlob,
  init: CiphertextSourceInit,
): E2eFileSource {
  const segmentSize = init.segmentSize ?? SEGMENT_SIZE;
  const plainLen = file.size;
  const header = buildHeader({ noncePrefix: init.noncePrefix, plainLen, segmentSize });
  const total = e2eCiphertextSize(plainLen, segmentSize);
  const count = segmentCount(plainLen, segmentSize);

  // Consecutive slices overlap on at most one segment; caching that one is the
  // difference between sealing each segment once and sealing it twice.
  let cachedIndex = -1;
  let cachedBytes: Bytes | null = null;

  async function sealedSegment(index: number): Promise<Bytes> {
    if (index === cachedIndex && cachedBytes) return cachedBytes;
    const start = index * segmentSize;
    const end = Math.min(start + segmentSize, plainLen);
    const plain = new Uint8Array(await file.slice(start, end).arrayBuffer());
    const sealed = await sealSegment(init.key, header, index, plain);
    cachedIndex = index;
    cachedBytes = sealed;
    return sealed;
  }

  return {
    size: total,

    async slice(start: number, end: number) {
      const from = Math.max(0, Math.min(start, total));
      const to = Math.max(from, Math.min(end, total));
      const out = new Uint8Array(to - from);
      let written = 0;

      // The header, when the window reaches into it.
      if (from < HEADER_LEN) {
        const take = header.subarray(from, Math.min(to, HEADER_LEN));
        out.set(take, 0);
        written = take.length;
      }

      let pos = from + written;
      while (pos < to) {
        const index = segmentAtOffset(pos, segmentSize);
        if (index >= count) break;
        const segStart = sealedOffsetOf(index, segmentSize);
        const segLen = sealedLengthOf(index, plainLen, segmentSize);
        const sealed = await sealedSegment(index);
        const inner = pos - segStart;
        const take = sealed.subarray(inner, Math.min(inner + (to - pos), segLen));
        out.set(take, written);
        written += take.length;
        pos += take.length;
        // A zero-length take would spin forever; it can only happen if the
        // arithmetic above is wrong, so say so rather than hang.
        if (take.length === 0) throw new Error(`e2e slice stalled at ciphertext offset ${pos}`);
      }

      return { value: written === out.length ? out : out.subarray(0, written), done: to >= total };
    },

    close() {
      cachedIndex = -1;
      cachedBytes = null;
    },
  };
}

/** What tus-js-client consumes: bytes that also answer `.size`. See below. */
export type TusChunk = Uint8Array & { readonly size: number };

export interface TusFileSource {
  size: number;
  slice(start: number, end: number): Promise<{ value: TusChunk; done: boolean }>;
  close(): void;
}

/**
 * A `fileReader` for tus-js-client.
 *
 * The `size` property is not decoration, and it is why this wrapper exists.
 * tus-js-client advances its own offset with
 * `const valueSize = value?.size ? value.size : 0` (upload.js). A `Uint8Array`
 * has `.length` and `.byteLength` but **no `.size`**, so tus concluded that
 * zero bytes had been sent on every chunk, never advanced, and retried until it
 * gave up — while the server accepted every byte. It reached users as
 * "connection hiccup, resuming automatically" with no connection problem
 * anywhere, which is about the least diagnosable shape a bug can take.
 *
 * A `Blob` has `.size` and is what the browser's own FileSource returns, but
 * tus's **Node** http stack refuses one outright ("chunk must be string,
 * Buffer or Uint8Array"), which would make this untestable outside a browser —
 * and untested is how the bug shipped. A `Uint8Array` carrying a `size`
 * property satisfies both: the browser's XHR accepts an ArrayBufferView as a
 * body, Node's stack accepts it as bytes, and tus's offset arithmetic finds
 * the number it looks for.
 *
 * `input` is whatever was handed to `new tus.Upload(...)`; the `chunkSize` tus
 * passes is ignored because the source is random-access.
 */
export function toTusFileSource(source: E2eFileSource): TusFileSource {
  return {
    size: source.size,
    async slice(start: number, end: number) {
      const { value, done } = await source.slice(start, end);
      // Non-enumerable so nothing iterating the array trips over it.
      Object.defineProperty(value, 'size', {
        value: value.byteLength,
        enumerable: false,
        configurable: true,
      });
      return { value: value as TusChunk, done };
    },
    close: () => source.close(),
  };
}

export function createE2eFileReader(init: CiphertextSourceInit) {
  return {
    async openFile(input: SliceableBlob): Promise<TusFileSource> {
      return toTusFileSource(createCiphertextSource(input, init));
    },
  };
}

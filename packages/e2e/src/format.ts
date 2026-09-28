/**
 * The client-side (end-to-end) ciphertext format.
 *
 * Deliberately the same *shape* as the server's envelope format in
 * `@yungle/crypto` — fixed-size plaintext segments, each sealed independently
 * with AES-256-GCM under a nonce of `[4-byte file prefix][8-byte segment
 * counter]`, laid out as `ciphertext || 16-byte tag`. That makes every full
 * segment exactly `segmentSize + TAG_LEN` bytes, so any byte offset into the
 * ciphertext maps back to a segment by arithmetic alone. `source.ts` depends
 * on that: it is what lets a resumable upload seek into the middle of a file it
 * is encrypting on the fly.
 *
 * Two things differ from the server format, both on purpose:
 *
 *  1. **There is a header.** The server keeps `nonce_prefix`, `segment_size`
 *     and the plaintext length in Postgres columns. We cannot — the whole point
 *     is that the server learns nothing — so the object describes itself.
 *
 *  2. **The header is bound into every segment's AAD.** The header is not
 *     encrypted, and the party storing it is exactly the party we are
 *     defending against. Binding it means a server that edits the declared
 *     plaintext length, segment size or nonce prefix produces a file that fails
 *     to open rather than one that opens to something else. Trailing truncation
 *     is then caught by checking the decrypted length against the *authenticated*
 *     `plainLen`.
 *
 * This ciphertext is what the browser hands to tus. The server treats it as
 * ordinary plaintext and applies its own envelope encryption on top, so nothing
 * in the upload/download/rotation/shredding pipeline needed to change.
 */

/**
 * WebCrypto's typings want a view backed by a real `ArrayBuffer`, not the
 * `ArrayBufferLike` a bare `Uint8Array` widens to (it could be a
 * `SharedArrayBuffer`). Everything here comes from `new Uint8Array(…)`,
 * `TextEncoder` or `subtle.*`, all of which already produce that, so naming it
 * costs nothing and keeps every crypto call below checkable.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** `YGE1` — magic, so a truncated or mis-routed object fails loudly. */
export const MAGIC: Bytes = Uint8Array.from([0x59, 0x47, 0x45, 0x31]);
export const VERSION = 1;
/** magic(4) | version(1) | segSizeLog2(1) | reserved(2) | noncePrefix(4) | plainLen(8) */
export const HEADER_LEN = 20;
export const TAG_LEN = 16;
export const NONCE_PREFIX_LEN = 4;
/** Plaintext segment size: 1 MiB, matching the server's DEFAULT_SEGMENT_SIZE. */
export const SEGMENT_SIZE = 1 << 20;

export interface E2eHeader {
  version: number;
  segmentSize: number;
  noncePrefix: Bytes;
  plainLen: number;
}

/** Number of sealed segments for a plaintext of `plainLen` bytes. */
export function segmentCount(plainLen: number, segmentSize = SEGMENT_SIZE): number {
  return plainLen === 0 ? 0 : Math.ceil(plainLen / segmentSize);
}

/**
 * Total ciphertext length the browser will upload for a file of `plainLen`.
 *
 * This is the number the API is told at row-creation time, because
 * `EncryptingTusStore.create()` asserts `upload.size === files.size_bytes` and
 * `size_bytes` goes on to drive `content-length` and the server's own
 * truncation guard. Getting it wrong is not a rounding error — it fails the
 * upload at the first byte.
 */
export function e2eCiphertextSize(plainLen: number, segmentSize = SEGMENT_SIZE): number {
  return HEADER_LEN + plainLen + segmentCount(plainLen, segmentSize) * TAG_LEN;
}

function log2Exact(n: number): number {
  const l = Math.log2(n);
  if (!Number.isInteger(l)) throw new Error(`segment size ${n} is not a power of two`);
  return l;
}

export function buildHeader(h: {
  noncePrefix: Bytes;
  plainLen: number;
  segmentSize?: number;
}): Bytes {
  const segmentSize = h.segmentSize ?? SEGMENT_SIZE;
  if (h.noncePrefix.length !== NONCE_PREFIX_LEN) {
    throw new Error(`nonce prefix must be ${NONCE_PREFIX_LEN} bytes`);
  }
  const out = new Uint8Array(HEADER_LEN);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = log2Exact(segmentSize);
  // bytes 6-7 reserved, left zero
  out.set(h.noncePrefix, 8);
  new DataView(out.buffer).setBigUint64(12, BigInt(h.plainLen));
  return out;
}

export function readHeader(bytes: Bytes): E2eHeader {
  if (bytes.length < HEADER_LEN) throw new Error('e2e header truncated');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('not a Yungle end-to-end encrypted object');
  }
  const version = bytes[4]!;
  if (version !== VERSION) throw new Error(`unsupported e2e format version ${version}`);
  const segmentSize = 2 ** bytes[5]!;
  const plainLen = Number(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(12),
  );
  if (!Number.isSafeInteger(plainLen)) throw new Error('e2e plaintext length out of range');
  return {
    version,
    segmentSize,
    noncePrefix: bytes.slice(8, 8 + NONCE_PREFIX_LEN),
    plainLen,
  };
}

function counterBytes(index: number): Bytes {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(index));
  return b;
}

function segmentNonce(noncePrefix: Bytes, index: number): Bytes {
  const n = new Uint8Array(12);
  n.set(noncePrefix, 0);
  n.set(counterBytes(index), NONCE_PREFIX_LEN);
  return n;
}

/** AAD = the whole header || the segment counter. See the note at the top. */
function aad(header: Bytes, index: number): Bytes {
  const a = new Uint8Array(header.length + 8);
  a.set(header, 0);
  a.set(counterBytes(index), header.length);
  return a;
}

/** Byte offset of segment `index` within the ciphertext object. */
export function sealedOffsetOf(index: number, segmentSize = SEGMENT_SIZE): number {
  return HEADER_LEN + index * (segmentSize + TAG_LEN);
}

/** Sealed length of segment `index` (the last one is short). */
export function sealedLengthOf(
  index: number,
  plainLen: number,
  segmentSize = SEGMENT_SIZE,
): number {
  const plain = Math.min(segmentSize, plainLen - index * segmentSize);
  if (plain < 0) throw new RangeError(`segment ${index} is past the end of the file`);
  return plain + TAG_LEN;
}

/**
 * Which segment contains ciphertext byte `offset`.
 *
 * Sound because every segment but the last is exactly `segmentSize + TAG_LEN`
 * bytes, and the short one is by definition final.
 */
export function segmentAtOffset(offset: number, segmentSize = SEGMENT_SIZE): number {
  if (offset < HEADER_LEN) return 0;
  return Math.floor((offset - HEADER_LEN) / (segmentSize + TAG_LEN));
}

export async function sealSegment(
  key: CryptoKey,
  header: Bytes,
  index: number,
  plaintext: Bytes,
): Promise<Bytes> {
  const { noncePrefix } = readHeader(header);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: segmentNonce(noncePrefix, index), additionalData: aad(header, index) },
    key,
    plaintext,
  );
  return new Uint8Array(sealed);
}

export async function openSegment(
  key: CryptoKey,
  header: Bytes,
  index: number,
  sealed: Bytes,
): Promise<Bytes> {
  if (sealed.length < TAG_LEN) throw new Error(`sealed segment ${index} too short`);
  const { noncePrefix } = readHeader(header);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: segmentNonce(noncePrefix, index), additionalData: aad(header, index) },
    key,
    sealed,
  );
  return new Uint8Array(plain);
}

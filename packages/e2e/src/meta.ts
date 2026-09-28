/**
 * Sealing the small things: filenames, the sender's message, thumbnails.
 *
 * These are single-shot rather than segmented — they are kilobytes, not
 * gigabytes — and land in the database as base64 text (`files.name_encrypted`,
 * `transfers.meta_encrypted`) or as a stored object (an encrypted thumbnail).
 *
 * Layout is `nonce(12) || ciphertext || tag(16)`. The `info` string goes in as
 * AAD, so a blob sealed as one file's name cannot be replayed as another's —
 * the server holds all of these rows and could otherwise shuffle them.
 */

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

import type { Bytes } from './format';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sealBytes(key: CryptoKey, data: Bytes, info: string): Promise<Bytes> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: utf8.encode(info) },
      key,
      data,
    ),
  );
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, nonce.length);
  return out;
}

export async function openBytes(key: CryptoKey, blob: Bytes, info: string): Promise<Bytes> {
  if (blob.length < 12 + 16) throw new Error('sealed blob too short');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.subarray(0, 12), additionalData: utf8.encode(info) },
    key,
    blob.subarray(12),
  );
  return new Uint8Array(plain);
}

/** Seal a JSON value to base64 text, for storage in a `text` column. */
export async function sealJson(key: CryptoKey, value: unknown, info: string): Promise<string> {
  return toBase64(await sealBytes(key, utf8.encode(JSON.stringify(value)), info));
}

export async function openJson<T>(key: CryptoKey, blob: string, info: string): Promise<T> {
  return JSON.parse(utf8Decode.decode(await openBytes(key, fromBase64(blob), info))) as T;
}

export { toBase64, fromBase64 };

// ── The metadata we actually seal ───────────────────────────────────────────

/**
 * What the server is allowed to know about an E2E file is: it exists, how many
 * ciphertext bytes it is, and when. Everything else lives in here.
 */
export interface SealedFileMeta {
  name: string;
  /** Directory this file sat in when a folder was dropped, if any. */
  path?: string;
  /** True plaintext size — `files.size_bytes` holds the ciphertext size. */
  size: number;
  type: string;
}

export interface SealedTransferMeta {
  message?: string;
}

export const fileMetaInfo = (fileId: string) => `yungle/name/v1:${fileId}`;
export const transferMetaInfo = (slug: string) => `yungle/transfer-meta/v1:${slug}`;
export const thumbInfo = (fileId: string) => `yungle/thumb-blob/v1:${fileId}`;

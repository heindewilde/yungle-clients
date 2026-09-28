/**
 * Key derivation for end-to-end encrypted transfers and the Vault.
 *
 * Everything hangs off one 256-bit master key. For a transfer that is the key
 * in the share link's fragment; for the Vault it is the key the passphrase
 * unwraps. Per-purpose keys come from HKDF-SHA256 with a distinct `info`
 * string, so a leaked thumbnail key cannot open the file it was made from and
 * neither can open a sibling file.
 *
 * The master is held as a **non-extractable** HKDF `CryptoKey`. WebCrypto
 * requires that for HKDF anyway, and it is what lets the Vault park the key in
 * IndexedDB across page loads without the raw bytes ever being readable by JS.
 * A transfer additionally needs the raw bytes, because they have to be encoded
 * into the URL fragment — so {@link generateMasterBytes} hands those back once,
 * at generation time, and nothing stores them afterwards.
 */

import { NONCE_PREFIX_LEN, type Bytes } from './format';

const INFO_META = 'yungle/meta/v1';
const INFO_FILE = 'yungle/file/v1:';
const INFO_THUMB = 'yungle/thumb/v1:';
const INFO_PREFIX = 'yungle/prefix/v1:';

/** An HKDF base key. Non-extractable by construction. */
export type MasterKey = CryptoKey;

const utf8 = (s: string) => new TextEncoder().encode(s);

/** 32 fresh random bytes. The only moment the master exists as plain bytes. */
export function generateMasterBytes(): Bytes {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function importMaster(raw: Bytes): Promise<MasterKey> {
  if (raw.length !== 32) throw new Error('master key must be 32 bytes');
  // HKDF keys must be non-extractable — WebCrypto throws otherwise.
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

function hkdf(info: string): HkdfParams {
  return { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) };
}

async function deriveAesKey(master: MasterKey, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(hkdf(info), master, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Key for filenames, the sender's message, and anything else metadata-shaped. */
export function deriveMetaKey(master: MasterKey): Promise<CryptoKey> {
  return deriveAesKey(master, INFO_META);
}

export function deriveFileKey(master: MasterKey, fileId: string): Promise<CryptoKey> {
  return deriveAesKey(master, INFO_FILE + fileId);
}

export function deriveThumbKey(master: MasterKey, fileId: string): Promise<CryptoKey> {
  return deriveAesKey(master, INFO_THUMB + fileId);
}

/**
 * The file's 4-byte nonce prefix, derived rather than random.
 *
 * Random would mean persisting it: the header is covered by every segment's
 * AAD, so a resumed upload that regenerated its prefix would produce bytes that
 * do not continue the ones already in S3, and the file would be quietly
 * unreadable. Deriving it from (master, fileId) makes the whole header
 * reproducible from things we already have, and uniqueness still holds because
 * the file key is itself unique per file.
 */
export async function deriveNoncePrefix(master: MasterKey, fileId: string): Promise<Bytes> {
  const bits = await crypto.subtle.deriveBits(
    hkdf(INFO_PREFIX + fileId),
    master,
    NONCE_PREFIX_LEN * 8,
  );
  return new Uint8Array(bits);
}

/** Everything needed to seal or open one file's body. */
export async function deriveFileMaterial(
  master: MasterKey,
  fileId: string,
): Promise<{ key: CryptoKey; noncePrefix: Bytes }> {
  const [key, noncePrefix] = await Promise.all([
    deriveFileKey(master, fileId),
    deriveNoncePrefix(master, fileId),
  ]);
  return { key, noncePrefix };
}

// ── URL fragment encoding ───────────────────────────────────────────────────

/**
 * The `k1.` prefix is a format discriminator, not decoration: a future `k2`
 * scheme must not be silently mis-read by this code, and a `k1` link must not
 * be mis-read by that one. Failing closed on an unknown prefix is the point.
 */
const FRAGMENT_PREFIX = 'k1.';

export function base64UrlEncode(bytes: Bytes): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Bytes {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `k1.<base64url>` — appended to the share link as `#k1.…` by the browser only. */
export function encodeKeyFragment(raw: Bytes): string {
  return FRAGMENT_PREFIX + base64UrlEncode(raw);
}

/** Tolerates a leading `#`. Returns null for anything it does not recognise. */
export function decodeKeyFragment(fragment: string): Bytes | null {
  const s = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!s.startsWith(FRAGMENT_PREFIX)) return null;
  try {
    const raw = base64UrlDecode(s.slice(FRAGMENT_PREFIX.length));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * `yungle get <link>` — download a transfer someone sent you.
 *
 * No API key: the link is the credential, exactly as it is in a browser. The
 * server's `/api/t/<slug>/manifest` hands back the same signed download URLs the
 * `/t` page renders, under the same rules (one download session per call, the
 * same password budget), so this is a browser that happens to live in a shell.
 *
 * The parsing and naming rules are pure and exported for tests; the rest is I/O.
 */

export interface TransferLink {
  origin: string;
  slug: string;
  /** Per-recipient id (`?r=`), so the sender's receipt names the right person. */
  recipient: string | null;
  /** An E2E key in the #fragment. Present means the files are encrypted to it. */
  hasKey: boolean;
}

const SLUG = /^[A-Za-z0-9_-]{8,128}$/;

/** A full link (`https://yungle.co/t/…`) or a bare slug, resolved against `defaultOrigin`. */
export function parseTransferLink(input: string, defaultOrigin: string): TransferLink {
  const text = input.trim();
  if (SLUG.test(text)) return { origin: defaultOrigin, slug: text, recipient: null, hasKey: false };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Not a Yungle transfer link: ${text}`);
  }
  const m = url.pathname.match(/^\/t\/([^/]+)\/?$/);
  if (!m || !SLUG.test(m[1]!)) {
    throw new Error(
      url.pathname.startsWith('/c/')
        ? 'That is a collection link. `yungle get` downloads transfers (/t/…) for now.'
        : `Not a Yungle transfer link: ${text}`,
    );
  }
  return { origin: url.origin, slug: m[1]!, recipient: url.searchParams.get('r'), hasKey: url.hash.length > 1 };
}

/**
 * A server-supplied file name made safe to write in `dir`.
 *
 * The name comes from whoever sent the transfer, so it is untrusted: `../`,
 * an absolute path, a NUL, or a Windows-reserved character must not decide
 * where bytes land. Only the last path segment survives.
 */
export function safeFileName(name: string): string {
  const last = basename(name.replace(/\\/g, '/'));
  // Control characters are the point here: a NUL or newline in a name is hostile.
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+$/, '_').trim();
  return cleaned || 'file';
}

/** `a.txt`, `a.txt` → `a.txt`, `a (2).txt`: two files never write to one path. */
export function dedupeNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/**
 * What to do with a partial download already on disk. Resuming asks for the
 * rest with `Range`; a server that answers 200 instead of 206 sent the whole
 * file, so the partial is discarded rather than appended to.
 */
export function resumeFrom(partialBytes: number, expectedSize: number): number | null {
  if (partialBytes <= 0 || partialBytes >= expectedSize) return null;
  return partialBytes;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

export interface ManifestFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  downloadUrl: string;
}

export interface Manifest {
  message: string | null;
  expiresAt: string;
  e2ee: boolean;
  zipUrl: string | null;
  files: ManifestFile[];
}

export class ManifestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

export async function fetchManifest(
  link: TransferLink,
  password: string | undefined,
  userAgent: string,
): Promise<Manifest> {
  const res = await fetch(`${link.origin}/api/t/${encodeURIComponent(link.slug)}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({ ...(password ? { password } : {}), ...(link.recipient ? { r: link.recipient } : {}) }),
  });
  const body = (await res.json().catch(() => null)) as (Manifest & { error?: { code: string; message: string } }) | null;
  if (!res.ok || !body || body.error) {
    const code = body?.error?.code ?? `http_${res.status}`;
    const message =
      code === 'not_found'
        ? 'No such transfer. Check the link, or it may have been deleted.'
        : (body?.error?.message ?? `The server answered ${res.status}.`);
    throw new ManifestError(code, message);
  }
  return body;
}

/**
 * Stream one URL to `dest`, resuming a `.part` file left by an interrupted run.
 * The `.part` is renamed into place only once complete, so a file with the
 * final name is always a whole file.
 */
export async function downloadTo(
  url: string,
  dest: string,
  expectedSize: number | null,
  userAgent: string,
  onBytes: (n: number) => void,
): Promise<void> {
  await mkdir(join(dest, '..'), { recursive: true });
  const part = `${dest}.part`;
  const have = await stat(part).then((s) => s.size, () => 0);
  const from = expectedSize === null ? null : resumeFrom(have, expectedSize);

  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent, ...(from !== null ? { Range: `bytes=${from}-` } : {}) },
  });
  if (res.status === 410) throw new ManifestError('expired', 'The transfer expired, was revoked, or reached its download limit.');
  if (!res.ok || !res.body) throw new ManifestError(`http_${res.status}`, `Download failed with ${res.status}.`);

  const appending = from !== null && res.status === 206;
  if (appending) onBytes(from);
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body.pipeThrough(counter) as import('node:stream/web').ReadableStream),
    createWriteStream(part, { flags: appending ? 'a' : 'w' }),
  );
  await rename(part, dest);
}

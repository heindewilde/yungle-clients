import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RESUME_PATH } from './config';
import type { LocalFile } from './files';

/**
 * `yungle watch <dir> --collection <id>`: keep a collection filled from a
 * folder — a render box writing frames, a card reader, an export folder.
 *
 * Polling rather than fs.watch: fs.watch is unreliable on network shares and
 * external drives, which is exactly where this is used, and a render farm does
 * not need sub-second latency. The rules that matter are pure and tested:
 *
 *  - **A file goes up only once it has stopped changing** — the same size and
 *    mtime on two consecutive looks. Uploading a frame while it is still being
 *    written would send half a file, and the size registered up front would not
 *    match the bytes.
 *  - **What went up is remembered** across restarts, in the cache directory,
 *    keyed by folder and collection, so stopping and starting never re-uploads.
 *  - **Files already there when it starts are left alone** unless --existing:
 *    watching a folder you have been working in for a month should not upload
 *    the month.
 */

export type Fingerprint = string;

export function fingerprint(f: Pick<LocalFile, 'path' | 'size' | 'mtimeMs'>): Fingerprint {
  return `${f.path}|${f.size}|${Math.floor(f.mtimeMs)}`;
}

export interface TickResult {
  /** Stable and never uploaded: send these now. */
  ready: LocalFile[];
  /** Everything seen this time, to compare against next time. */
  seen: Set<Fingerprint>;
}

export function planTick(current: LocalFile[], lastSeen: Set<Fingerprint>, uploaded: Set<Fingerprint>): TickResult {
  const seen = new Set(current.map(fingerprint));
  const ready = current.filter((f) => {
    const fp = fingerprint(f);
    return !uploaded.has(fp) && lastSeen.has(fp);
  });
  return { ready, seen };
}

function statePath(dir: string, collectionId: string): string {
  const key = createHash('sha256').update(`${dir}\n${collectionId}`).digest('hex').slice(0, 16);
  return join(dirname(RESUME_PATH), `watch-${key}.json`);
}

export async function loadUploaded(dir: string, collectionId: string): Promise<Set<Fingerprint>> {
  try {
    return new Set(JSON.parse(await readFile(statePath(dir, collectionId), 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

export async function saveUploaded(dir: string, collectionId: string, uploaded: Set<Fingerprint>): Promise<void> {
  const p = statePath(dir, collectionId);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  await writeFile(p, JSON.stringify([...uploaded]), { mode: 0o600 });
}

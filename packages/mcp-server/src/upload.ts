import { openAsBlob } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { YungleClient } from 'yungle-client';

/**
 * Putting bytes behind upload targets, through the SDK's `uploadFile`:
 * resumable at part granularity, retried with a HEAD after a drop, and with the
 * two-hour upload token renewed for as long as it runs. The hand-written loop
 * this replaces had none of the three, so a local share of a big file failed on
 * the first network blip, or at the two-hour mark regardless.
 */

export interface Target {
  id: string;
  name: string;
  uploadToken: string;
}

export function uploadBytes(client: YungleClient, endpoint: string, target: Target, bytes: Uint8Array): Promise<unknown> {
  return client.uploadFile(endpoint, target, new Blob([bytes as unknown as ArrayBuffer]));
}

export async function uploadPath(
  client: YungleClient,
  endpoint: string,
  target: Target,
  path: string,
  onProgress?: (sent: number) => void,
): Promise<unknown> {
  // A file-backed Blob: sliced per PATCH, read from disk as it is sent.
  return client.uploadFile(endpoint, target, await openAsBlob(path), { onProgress: (sent) => onProgress?.(sent) });
}

export interface LocalFile {
  path: string;
  size: number;
  /** Folder path to recreate, relative to what was shared; `''` for a loose file. */
  dir: string;
}

const isHiddenName = (name: string) => name.startsWith('.');

/**
 * Expand files and folders into files. Inside a folder, hidden entries are
 * skipped and symbolic links are not followed — a link inside a shared folder
 * pointing at `~/.ssh` must not come along. At most `max` files.
 */
export async function expandPaths(paths: string[], max = 500): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const walk = async (root: string, dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (isHiddenName(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(root, full);
      else if (entry.isFile()) {
        if (out.length >= max) throw new Error(`More than ${max} files; share fewer at once.`);
        out.push({ path: full, size: (await lstat(full)).size, dir: relative(dirname(root), dir) });
      }
    }
  };
  for (const p of paths) {
    const st = await lstat(p);
    if (st.isDirectory()) await walk(p, p);
    else if (st.isFile()) {
      if (out.length >= max) throw new Error(`More than ${max} files; share fewer at once.`);
      out.push({ path: p, size: st.size, dir: '' });
    }
  }
  return out;
}

export { basename };

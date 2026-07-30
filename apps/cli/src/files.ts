import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

/**
 * Turning command-line paths into the file list the API wants.
 *
 * Pure enough to test: everything that decides *what* gets uploaded and *where
 * it lands* is here, and the only I/O is reading directory entries.
 */

export interface LocalFile {
  /** Absolute path on disk. */
  path: string;
  name: string;
  size: number;
  /** Directory relative to the walk root, '' for a loose file. */
  relativeDir: string;
  /**
   * Last modification time, carried so `sessionKey` can tell an interrupted
   * upload of *these* files from an upload of a file that has since changed
   * under the same name.
   */
  mtimeMs: number;
}

/**
 * Hidden entries are skipped **when walking a directory** but kept when named
 * directly.
 *
 * A dropped shoot folder carries `.DS_Store` in every subdirectory, and each
 * one would otherwise become a quota-counted file in the client's gallery. But
 * `yungle send .npmrc` is an explicit instruction and refusing it would be
 * baffling. The same rule the browser uploader uses.
 */
function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export async function collectFiles(inputs: string[]): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  for (const input of inputs) {
    const absolute = resolve(input);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      // The directory's own name becomes the top of the tree, so
      // `yungle push ./Ceremony` produces `Ceremony/...` rather than dumping
      // its contents loose into the collection root.
      await walk(absolute, basename(absolute), out);
    } else {
      out.push({
        path: absolute,
        name: basename(absolute),
        size: info.size,
        relativeDir: '',
        mtimeMs: info.mtimeMs,
      });
    }
  }
  return out;
}

async function walk(dir: string, prefix: string, out: LocalFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, `${prefix}/${entry.name}`, out);
    } else if (entry.isFile()) {
      const info = await stat(full);
      out.push({
        path: full,
        name: entry.name,
        size: info.size,
        relativeDir: prefix,
        mtimeMs: info.mtimeMs,
      });
    }
    // Symlinks and sockets are skipped: `isFile()` is false for both, and
    // following a symlink out of the tree is how a folder upload quietly ships
    // something the user never meant to send.
  }
}

/** The shape `POST /transfers` and `POST /collections/{id}/files` accept. */
export function toFileInputs(files: LocalFile[]): { name: string; size: number; path?: string }[] {
  return files.map((f) => ({
    name: f.name,
    size: f.size,
    ...(f.relativeDir ? { path: f.relativeDir } : {}),
  }));
}

/**
 * How the API's per-file response lines up with what is on disk.
 *
 * **By position, never by name.** The routes return files in the order they
 * were sent, and matching on `name + size` instead is a real bug the browser
 * uploader shipped: two files with the same name in different directories —
 * which is most of a photo shoot — resolve to the same server row, so one
 * upload overwrites the other and one row is orphaned. Folder uploads make that
 * collision ordinary rather than exotic.
 */
export function pairWithTargets<T>(files: LocalFile[], targets: T[]): { file: LocalFile; target: T }[] {
  if (files.length !== targets.length) {
    throw new Error(
      `The server returned ${targets.length} upload targets for ${files.length} files. Refusing to guess which is which.`,
    );
  }
  return files.map((file, i) => ({ file, target: targets[i]! }));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Longest-common-prefix trimming so `yungle send a/b/c.jpg` is named `c.jpg`. */
export function displayPath(file: LocalFile, root: string): string {
  const rel = relative(root, file.path);
  return rel.startsWith('..') ? file.path : rel.split(sep).join('/');
}

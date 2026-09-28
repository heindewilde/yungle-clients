import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadLinks } from 'yungle-client';

/**
 * Saving a set of download links to this machine, for `download_files`.
 *
 * Names and folder paths are chosen by whoever shared the files, so they are
 * untrusted: every segment is sanitised, `.`/`..` dropped, and the final path
 * is checked to still be inside the destination before a byte is written.
 * Resumes a `.part` left by an interrupted run with `Range`.
 */

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\x00-\x1f<>:"|?*]/g;

export function safeSegment(name: string): string {
  const cleaned = name.replace(UNSAFE, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

/** `path` + `name` → a relative path that cannot leave the destination. */
export function safeRelative(path: string | undefined, name: string): string {
  const dirs = (path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map(safeSegment);
  const last = name.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'file';
  return [...dirs, safeSegment(last)].join('/');
}

export interface SavedFile {
  path: string;
  bytes: number;
  skipped: boolean;
}

export async function saveLinks(links: DownloadLinks, destination: string, doFetch: typeof fetch = fetch): Promise<SavedFile[]> {
  const root = resolve(destination);
  const used = new Set<string>();
  const out: SavedFile[] = [];
  for (const f of links.files) {
    let rel = safeRelative(f.path, f.name);
    const dot = rel.lastIndexOf('.');
    const slash = rel.lastIndexOf('/');
    const [stem, ext] = dot > slash + 1 ? [rel.slice(0, dot), rel.slice(dot)] : [rel, ''];
    for (let n = 2; used.has(rel.toLowerCase()); n++) rel = `${stem} (${n})${ext}`;
    used.add(rel.toLowerCase());
    const dest = join(root, rel);
    if (!dest.startsWith(root + sep)) throw new Error(`Refused a path outside the destination: ${rel}`);

    const existing = await stat(dest).then((s) => s.size, () => -1);
    if (existing === f.size) {
      out.push({ path: dest, bytes: f.size, skipped: true });
      continue;
    }
    await fetchTo(f.downloadUrl, dest, f.size, doFetch);
    out.push({ path: dest, bytes: f.size, skipped: false });
  }
  return out;
}

async function fetchTo(url: string, dest: string, size: number, doFetch: typeof fetch): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const have = await stat(part).then((s) => s.size, () => 0);
  const resume = have > 0 && have < size;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch(url, resume ? { headers: { Range: `bytes=${have}-` } } : {});
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
      const appending = resume && res.status === 206;
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        createWriteStream(part, { flags: appending ? 'a' : 'w' }),
      );
      await rename(part, dest);
      return;
    } catch (err) {
      if (attempt >= 2 || /HTTP 4\d\d/.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return fetchTo(url, dest, size, doFetch);
    }
  }
}

import { open } from 'node:fs/promises';

/**
 * Just enough tus to put bytes behind an upload target, with nothing but fetch.
 *
 * The server commits in parts and answers each PATCH with the last committed
 * boundary, which can be short of what was sent, so the loop always resumes
 * from the offset it is given. A chunk smaller than a part never moves that
 * boundary, hence the floor on the chunk size.
 */

const MiB = 1024 * 1024;

export function chunkSize(size: number): number {
  return Math.max(64 * MiB, (Math.floor(size / (9000 * MiB)) + 2) * MiB);
}

export interface Target {
  id: string;
  name: string;
  uploadToken: string;
}

type Reader = (offset: number, length: number) => Promise<Uint8Array>;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

async function tusUpload(endpoint: string, target: Target, size: number, read: Reader, doFetch: typeof fetch): Promise<void> {
  const auth = { 'Tus-Resumable': '1.0.0', 'x-yungle-upload-token': target.uploadToken };
  const created = await doFetch(endpoint, {
    method: 'POST',
    headers: {
      ...auth,
      'Upload-Length': String(size),
      'Upload-Metadata': `fileId ${b64(target.id)},token ${b64(target.uploadToken)},filename ${b64(target.name)}`,
    },
  });
  if (!created.ok) throw new Error(`Upload of ${target.name} could not start (HTTP ${created.status}).`);
  const url = new URL(created.headers.get('location') ?? '', endpoint).toString();

  let offset = 0;
  let stalls = 0;
  const step = chunkSize(size);
  while (offset < size) {
    const body = await read(offset, Math.min(step, size - offset));
    const res = await doFetch(url, {
      method: 'PATCH',
      headers: { ...auth, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
      // A Uint8Array is a valid body at runtime; the cast is for DOM typings
      // that only accept ArrayBuffer-backed views.
      body: body as unknown as NonNullable<RequestInit["body"]>,
    });
    if (!res.ok) throw new Error(`Upload of ${target.name} failed (HTTP ${res.status}).`);
    const next = Number(res.headers.get('upload-offset'));
    if (!(next > offset)) {
      if (++stalls > 3) throw new Error(`Upload of ${target.name} made no progress.`);
    } else stalls = 0;
    offset = next;
  }
}

export function uploadBytes(endpoint: string, target: Target, bytes: Uint8Array, doFetch: typeof fetch = fetch): Promise<void> {
  return tusUpload(endpoint, target, bytes.byteLength, async (o, n) => bytes.subarray(o, o + n), doFetch);
}

export async function uploadPath(endpoint: string, target: Target, path: string, size: number, doFetch: typeof fetch = fetch): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await tusUpload(
      endpoint,
      target,
      size,
      async (o, n) => {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await handle.read(buf, 0, n, o);
        return buf.subarray(0, bytesRead);
      },
      doFetch,
    );
  } finally {
    await handle.close();
  }
}

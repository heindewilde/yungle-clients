import { createTokenKeeper, type RenewOutcome } from './upload-token';

/**
 * A resumable upload to Yungle's tus endpoint with nothing but `fetch` and a
 * `Blob` — so it runs in Node (`fs.openAsBlob(path)` streams from disk), Bun,
 * Deno and a browser, with no dependency.
 *
 * Three rules specific to this server, each of which fails silently if missed:
 *
 * - **The server commits in parts** and answers a PATCH with the last committed
 *   part boundary, which can be short of what was sent. The loop always
 *   continues from the offset it is given, never from what it sent; and a chunk
 *   smaller than one part never moves that boundary, hence `chunkSize`'s floor.
 * - **The token authorizes every request**, HEAD and PATCH included, and lasts
 *   two hours. Pass `renew` (e.g. `(t) => client.renewUploadToken(t)`) and it
 *   is renewed for as long as the upload runs.
 * - **Never re-create an upload that is in progress**: a second POST starts
 *   over with a fresh encryption key. Keep `uploadUrl` (via `onUploadUrl`) and
 *   pass it back to resume, even from another process.
 */

const MiB = 1024 * 1024;

/** At least one server part per PATCH, or the committed offset never advances. */
export function chunkSize(size: number): number {
  return Math.max(64 * MiB, (Math.floor(size / (9000 * MiB)) + 2) * MiB);
}

export interface UploadFileOptions {
  /** `tusEndpoint` from the create response. */
  endpoint: string;
  /** One entry of the create response's `files`. */
  target: { id: string; name: string; uploadToken: string };
  /** The bytes. In Node: `await fs.openAsBlob(path)`. */
  source: Blob;
  /** Renew the two-hour token; without it an upload longer than that fails. */
  renew?: (token: string) => Promise<RenewOutcome>;
  /** Resume this upload rather than creating one. */
  uploadUrl?: string;
  /** Called once the upload exists — store it to resume after a crash. */
  onUploadUrl?: (url: string) => void;
  /** Called with each renewed token — store it with `uploadUrl`. */
  onToken?: (token: string) => void;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Waits between retries of a failed request; its length is the retry budget. */
  retryDelaysMs?: number[];
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Worth another try: a dropped connection, an offset conflict, a throttle, a server hiccup. */
function transient(status: number): boolean {
  return status === 0 || status === 408 || status === 409 || status === 423 || status === 429 || status >= 500;
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export async function uploadFile(o: UploadFileOptions): Promise<{ uploadUrl: string }> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const size = o.source.size;
  const delays = o.retryDelaysMs ?? [0, 1000, 3000, 5000, 10_000, 30_000];
  const keeper = o.renew
    ? createTokenKeeper(o.target.uploadToken, {
        renew: async (t) => {
          const outcome = await o.renew!(t);
          if (typeof outcome === 'object') o.onToken?.(outcome.token);
          return outcome;
        },
      })
    : null;
  const auth = () => ({ 'Tus-Resumable': '1.0.0', 'x-yungle-upload-token': keeper?.current() ?? o.target.uploadToken });

  const request = async (url: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: o.signal });
    } catch (err) {
      if (o.signal?.aborted) throw err;
      throw new UploadError(`Connection failed: ${(err as Error).message}`, 0);
    }
    if (!res.ok) throw new UploadError(`Upload of ${o.target.name} got HTTP ${res.status}.`, res.status);
    return res;
  };
  const head = async (url: string) =>
    Number((await request(url, { method: 'HEAD', headers: auth() })).headers.get('upload-offset') ?? 0);

  try {
    let url = o.uploadUrl;
    let offset = 0;
    if (url) {
      try {
        offset = await head(url);
      } catch (err) {
        // Never created (or long gone): start clean. Anything else is real.
        if (!(err instanceof UploadError && err.status === 404)) throw err;
        url = undefined;
      }
    }
    if (!url) {
      const created = await request(o.endpoint, {
        method: 'POST',
        headers: {
          ...auth(),
          'Upload-Length': String(size),
          'Upload-Metadata': `fileId ${b64(o.target.id)},token ${b64(o.target.uploadToken)},filename ${b64(o.target.name)}`,
        },
      });
      url = new URL(created.headers.get('location') ?? '', o.endpoint).toString();
      o.onUploadUrl?.(url);
    }
    o.onProgress?.(offset, size);

    const step = chunkSize(size);
    let failures = 0;
    let stalls = 0;
    while (offset < size) {
      try {
        const res = await request(url, {
          method: 'PATCH',
          headers: { ...auth(), 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
          body: o.source.slice(offset, Math.min(size, offset + step)),
        });
        const next = Number(res.headers.get('upload-offset'));
        if (!(next > offset)) {
          if (++stalls > 3) throw new UploadError(`Upload of ${o.target.name} made no progress.`, res.status);
        } else stalls = 0;
        offset = next;
        failures = 0;
        o.onProgress?.(offset, size);
      } catch (err) {
        if (o.signal?.aborted) throw err;
        if (!(err instanceof UploadError) || !transient(err.status) || failures >= delays.length) throw err;
        await new Promise((r) => setTimeout(r, delays[failures++]));
        // Ask where the server actually is before sending anything else.
        try {
          offset = await head(url);
        } catch (headErr) {
          if (!(headErr instanceof UploadError) || !transient(headErr.status)) throw headErr;
        }
      }
    }
    return { uploadUrl: url };
  } finally {
    keeper?.stop();
  }
}

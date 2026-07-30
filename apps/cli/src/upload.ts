import type { UploadTarget } from 'yungle-client';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { clearUploadUrls, readUploadUrls, saveUploadUrl } from './config';

/**
 * Streaming files to the tus endpoint, resumably.
 *
 * This is the reason the CLI exists. The upload engine is resumable at part
 * granularity and sized for 100 GB, and until now the only thing that could
 * drive it was a browser tab that had to stay open — which is the wrong process
 * to hand an eight-hour upload to. A CLI in tmux is the right one.
 */

export interface UploadFile {
  /** Absolute path on disk. */
  path: string;
  /** The server-side row this maps to. */
  target: UploadTarget;
}

export interface UploadProgress {
  /** The server-side file id, so a concurrent caller can key state on it. */
  id: string;
  name: string;
  sent: number;
  total: number;
  /** Bytes per second over the whole upload so far. */
  rate: number;
  resumed: boolean;
}

/**
 * Concurrency for the pool.
 *
 * Three, matching the browser. It is not about saturating a link — one stream
 * usually does that — but about not stalling the whole batch on one slow part
 * commit, while staying well under the multipart bookkeeping a hundred parallel
 * uploads would create server-side.
 *
 * A purpose-built pool rather than `apps/web/lib/upload-queue.ts`, deliberately.
 * That reducer is shaped for the browser's upload strip — it carries a
 * `needs-drop` state for a re-dropped `File` and fields described as "shown in
 * the strip" — none of which can occur here. Lifting it would mean the CLI
 * carrying browser concepts and the web app gaining a Dockerfile entry for a
 * package production does not run.
 */
const CONCURRENCY = 3;

export async function uploadAll(
  files: UploadFile[],
  endpoint: string,
  onProgress: (p: UploadProgress) => void,
): Promise<void> {
  const queue = [...files];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await uploadOne(next, endpoint, onProgress);
    }
  });
  await Promise.all(workers);
  await clearUploadUrls(files.map((f) => f.target.id));
}

async function uploadOne(
  file: UploadFile,
  endpoint: string,
  onProgress: (p: UploadProgress) => void,
): Promise<void> {
  const tus = await import('tus-js-client');
  const { size } = await stat(file.path);
  const urls = await readUploadUrls();
  const uploadUrl = urls[file.target.id];
  const started = Date.now();

  await new Promise<void>((resolve, reject) => {
    // Declared before the options object that closes over it: onUploadUrlAvailable
    // needs to read `upload.url`, and the callback only ever runs after start().
    const upload: InstanceType<typeof tus.Upload> = new tus.Upload(createReadStream(file.path), {
      endpoint,
      /**
       * Reattach to an upload already in progress. The endpoint stays set as a
       * fallback: if the upload was never actually created the HEAD 404s and
       * tus falls back to a clean creation, which for zero progress is exactly
       * right. Never re-POST one that *is* in progress — that restarts it with
       * a fresh encryption key and abandons everything already sent.
       */
      ...(uploadUrl ? { uploadUrl } : {}),
      uploadSize: size,
      /**
       * The token authorizes EVERY method, not just the creation POST — the
       * server verifies HEAD, PATCH and DELETE too. Metadata below only reaches
       * the server on the first POST, so it cannot carry the token alone.
       */
      headers: { 'x-yungle-upload-token': file.target.uploadToken },
      metadata: {
        fileId: file.target.id,
        token: file.target.uploadToken,
        filename: file.target.name,
      },
      retryDelays: [0, 1000, 3000, 5000, 10_000, 30_000],
      /**
       * Persist the upload URL the moment the server hands one over, so a
       * `kill -9` a second later still resumes. Waiting until the upload
       * finishes would mean the state file only ever describes work that no
       * longer needs it.
       *
       * `onUploadUrlAvailable` and `upload.url`, **not** `onAfterResponse` +
       * `req.getURL()`: that returns the URL the request was *sent to*, which
       * for the creation POST is the endpoint itself, not the `Location` the
       * server answered with. The first version did that, and the symptom was
       * an empty resume file with no error anywhere — a killed upload silently
       * restarting from zero, which is the one thing this command exists to
       * prevent.
       */
      onUploadUrlAvailable: () => {
        const location = upload.url;
        if (location && !urls[file.target.id]) {
          urls[file.target.id] = location;
          void saveUploadUrl(file.target.id, location);
        }
      },
      onProgress: (sent, total) => {
        const elapsed = Math.max(1, Date.now() - started) / 1000;
        onProgress({
          id: file.target.id,
          name: file.target.name,
          sent,
          total: total || size,
          rate: sent / elapsed,
          resumed: Boolean(uploadUrl),
        });
      },
      onSuccess: () => resolve(),
      onError: (err) => reject(err),
    });
    upload.start();
  });
}

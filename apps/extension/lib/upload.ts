import * as tus from 'tus-js-client';
import { createTokenKeeper, renewUploadToken } from 'yungle-client';
import { createCiphertextSource, createE2eFileReader, serverChunkSize } from 'yungle-e2e';
import { ORIGIN } from './config';

/**
 * One file, streamed to Yungle's tus endpoint. Ported from the website's
 * `components/upload-core.ts`; the rules that matter are carried over with it.
 *
 * - The signed upload token authorizes EVERY tus request (HEAD, PATCH), not
 *   just creation, so it rides in a header as well as the metadata.
 * - Encrypted uploads MUST use `serverChunkSize`: the server answers a partial
 *   PATCH with its last committed part boundary, so any other chunk size makes
 *   the offset stop advancing and the client re-send forever.
 * - `Upload-Metadata` travels in the clear, so an encrypted upload's filename
 *   there is a placeholder.
 * - Upload tokens live two hours. A big file on a home connection outlasts
 *   that, so a keeper renews the token at half-life (the SDK's schedule, the
 *   same as the website's and the CLI's) and every request sends the current
 *   one. Renewing also tells the server the upload is alive.
 */

export interface UploadTarget {
  id: string;
  uploadToken: string;
}

export interface UploadHooks {
  onProgress: (bytesSent: number) => void;
  onReconnecting?: () => void;
  /** Receives an abort function. */
  register?: (abort: () => void) => void;
}

/** Statuses worth another attempt — the same list as the website's `isRetryableUploadStatus`. */
export function isRetryableUploadStatus(status: number): boolean {
  return [0, 409, 423, 429, 502, 503, 504].includes(status);
}

export type E2eMaterial = Parameters<typeof createE2eFileReader>[0];

export function uploadFile(
  file: File,
  target: UploadTarget,
  endpoint: string,
  hooks: UploadHooks,
  e2e?: E2eMaterial,
): Promise<void> {
  const ciphertextSize = e2e ? createCiphertextSource(file, e2e).size : null;
  // The credential here is the upload token itself, not the OAuth token.
  const keeper = createTokenKeeper(target.uploadToken, { renew: (t) => renewUploadToken(ORIGIN, t) });
  return new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint,
      ...(e2e && ciphertextSize !== null
        ? { fileReader: createE2eFileReader(e2e), chunkSize: serverChunkSize(ciphertextSize) }
        : {}),
      // ~54 seconds of retrying: long enough to ride out a deploy, which is the
      // disconnect that actually happens.
      retryDelays: [0, 1000, 3000, 5000, 10000, 15000, 20000],
      uploadSize: ciphertextSize ?? file.size,
      // Set per request rather than fixed here: the keeper swaps in fresh tokens.
      onBeforeRequest: (req) => req.setHeader('x-yungle-upload-token', keeper.current()),
      metadata: { fileId: target.id, token: target.uploadToken, filename: e2e ? 'encrypted' : file.name },
      onError: (err) => {
        const status = (err as tus.DetailedError).originalResponse?.getStatus() ?? 0;
        keeper.stop();
        reject(new UploadError(status));
      },
      onProgress: (sent) => hooks.onProgress(sent),
      onSuccess: () => {
        keeper.stop();
        resolve();
      },
      onShouldRetry: (err) => {
        const status = (err as tus.DetailedError).originalResponse?.getStatus() ?? 0;
        const transient = isRetryableUploadStatus(status);
        if (transient) hooks.onReconnecting?.();
        return transient;
      },
    });
    hooks.register?.(() => {
      keeper.stop();
      void upload.abort();
      reject(new UploadError(-1));
    });
    upload.start();
  });
}

/** `status` -1 means cancelled; 0 means the network went away and stayed away. */
export class UploadError extends Error {
  constructor(readonly status: number) {
    super(status === -1 ? 'cancelled' : `upload failed (${status})`);
    this.name = 'UploadError';
  }
}

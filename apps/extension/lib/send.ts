import {
  deriveFileMaterial,
  deriveMetaKey,
  e2eCiphertextSize,
  encodeKeyFragment,
  fileMetaInfo,
  generateMasterBytes,
  importMaster,
  sealJson,
  transferMetaInfo,
} from 'yungle-e2e';
import { api } from './api';
import { makeSealedThumbnail } from './thumbnail';
import { uploadFile, UploadError } from './upload';

/**
 * Send files: the website's composer, as one function. The order is the
 * server's contract, and each step exists for a reason:
 *
 * 1. Create a DRAFT. Nothing is live and nobody is emailed yet.
 * 2. E2E only: seal each file's name (and an image thumbnail) under its new
 *    id — the id is the AAD, and the server mints it, so this cannot happen
 *    before step 1.
 * 3. Upload the bytes with tus.
 * 4. Finalize: the link goes live and recipients are emailed. For E2E there
 *    are no recipients (the key is in the link) and the message is sealed.
 *
 * An E2E transfer never sends a real name, type or folder path to the
 * server, even in the create call — the server would overwrite them with
 * placeholders, but a value that is never sent cannot be logged.
 */

export interface SendInput {
  files: Array<{ file: File; path?: string }>;
  e2ee: boolean;
  recipients: string[];
  message: string;
  expiresInDays?: number;
}

export interface SendProgress {
  phase: 'preparing' | 'uploading' | 'finishing';
  sent: number;
  total: number;
  reconnecting: boolean;
}

export interface SendResult {
  link: string;
  expiresAt: string | null;
  e2ee: boolean;
  emailed: string[];
  fileNames: string[];
  totalBytes: number;
}

const PARALLEL_UPLOADS = 3;

export interface SendHandle {
  done: Promise<SendResult>;
  cancel: () => void;
}

export function send(input: SendInput, onProgress: (p: SendProgress) => void): SendHandle {
  const aborts = new Set<() => void>();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    for (const a of aborts) a();
  };
  return { done: run(input, onProgress, aborts, () => cancelled), cancel };
}

async function run(
  input: SendInput,
  onProgress: (p: SendProgress) => void,
  aborts: Set<() => void>,
  isCancelled: () => boolean,
): Promise<SendResult> {
  const { files, e2ee } = input;
  const plainTotal = files.reduce((s, f) => s + f.file.size, 0);
  const wireSize = (f: File) => (e2ee ? e2eCiphertextSize(f.size) : f.size);
  const total = files.reduce((s, f) => s + wireSize(f.file), 0);
  onProgress({ phase: 'preparing', sent: 0, total, reconnecting: false });

  const raw = e2ee ? generateMasterBytes() : null;
  const master = raw ? await importMaster(raw) : null;

  const created = await api().createTransfer({
    files: files.map(({ file, path }) =>
      e2ee
        ? { name: 'encrypted', size: wireSize(file) }
        : { name: file.name, size: file.size, type: file.type, ...(path ? { path } : {}) },
    ),
    ...(input.expiresInDays ? { expiresInDays: input.expiresInDays } : {}),
    ...(e2ee ? { e2ee: true } : {}),
  });
  const transferId = created.transfer.id;

  if (master) {
    const metaKey = await deriveMetaKey(master);
    await Promise.all(
      created.files.map(async (target, i) => {
        const item = files[i]!;
        const meta = await sealJson(
          metaKey,
          {
            name: item.file.name,
            ...(item.path ? { path: item.path } : {}),
            size: item.file.size,
            type: item.file.type || 'application/octet-stream',
          },
          fileMetaInfo(target.id),
        );
        const thumb = await makeSealedThumbnail(item.file, master, target.id);
        await api().sealTransferFile(transferId, target.id, { meta, ...(thumb ? { thumb } : {}) });
      }),
    );
  }

  // Upload, a few at a time.
  const sentPerFile = new Map<string, number>();
  let reconnecting = false;
  const report = () =>
    onProgress({ phase: 'uploading', sent: [...sentPerFile.values()].reduce((a, b) => a + b, 0), total, reconnecting });
  const queue = created.files.map((target, i) => ({ target, file: files[i]!.file }));
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      if (isCancelled()) throw new UploadError(-1);
      const material = master ? await deriveFileMaterial(master, next.target.id) : undefined;
      let abort: (() => void) | null = null;
      try {
        await uploadFile(
          next.file,
          next.target,
          created.tusEndpoint,
          {
            onProgress: (n) => {
              reconnecting = false;
              sentPerFile.set(next.target.id, n);
              report();
            },
            onReconnecting: () => {
              reconnecting = true;
              report();
            },
            register: (a) => {
              abort = a;
              aborts.add(a);
            },
          },
          material,
        );
      } finally {
        if (abort) aborts.delete(abort);
      }
    }
  };
  report();
  await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, worker));

  onProgress({ phase: 'finishing', sent: total, total, reconnecting: false });
  const message = input.message.trim();
  const finalized = master
    ? await api().finalizeTransfer(transferId, {
        ...(message
          ? { e2eeMeta: await sealJson(await deriveMetaKey(master), { message }, transferMetaInfo(created.transfer.slug)) }
          : {}),
      })
    : await api().finalizeTransfer(transferId, {
        ...(input.recipients.length ? { recipients: input.recipients } : {}),
        ...(message ? { message } : {}),
      });

  return {
    link: raw ? `${finalized.transfer.url}#${encodeKeyFragment(raw)}` : finalized.transfer.url,
    expiresAt: finalized.transfer.expiresAt,
    e2ee,
    emailed: finalized.notified,
    fileNames: files.map((f) => f.file.name),
    totalBytes: plainTotal,
  };
}

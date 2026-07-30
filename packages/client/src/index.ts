import type {
  Collection,
  CollectionFile,
  CollectionSummary,
  Contact,
  ContactInput,
  DownloadEvent,
  FileInput,
  Folder,
  Guest,
  Me,
  RecipientStatus,
  Transfer,
  TransferFile,
  TransferSummary,
  UploadTargets,
} from './types';

export * from './types';

/**
 * A typed client for the Yungle API.
 *
 * Deliberately dependency-free and built on `fetch`, so it runs unchanged in
 * Node 22, Bun, Deno and a server-side edge runtime. The CLI and the MCP server
 * are both thin layers over this — which is the point: one place understands
 * the wire format, so neither can drift from the other.
 *
 * It does **not** upload bytes. `createTransfer` and `addCollectionFiles`
 * return a tus endpoint and per-file tokens, and streaming to those is the
 * caller's job (`yungle-cli` does it with `tus-js-client`). Keeping the byte
 * pipeline out of here is what lets this stay a few hundred lines with no
 * dependencies.
 */

export interface YungleErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * A failed request. Carries the machine-readable `code` — branch on that, never
 * on `message`, which is written for a human reading a log and may change.
 */
export class YungleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'YungleApiError';
  }

  /** Worth trying again: throttled, or our fault. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** Seconds to wait, when the server said. */
  get retryAfterSeconds(): number | null {
    const value = this.details?.retryAfterSeconds;
    return typeof value === 'number' ? value : null;
  }
}

export interface ClientOptions {
  apiKey: string;
  /** Defaults to production. Point it at a local server for development. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Retries for throttles and 5xx. Set to 0 to handle it yourself.
   *
   * Only ever applied to requests that are safe to repeat — see `request()`.
   */
  maxRetries?: number;
}

const DEFAULT_BASE = 'https://yungle.co/api/v1';

export class YungleClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly maxRetries: number;

  constructor(options: ClientOptions) {
    if (!options.apiKey) throw new Error('An API key is required.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 3;
  }

  // ── Account ───────────────────────────────────────────────────────────────

  me(): Promise<Me> {
    return this.request('GET', '/me');
  }

  // ── Transfers ─────────────────────────────────────────────────────────────

  listTransfers(): Promise<{ transfers: TransferSummary[] }> {
    return this.request('GET', '/transfers');
  }

  /**
   * Create a draft. Nothing is live and nobody is emailed until `finalizeTransfer`.
   */
  createTransfer(input: {
    files: FileInput[];
    title?: string;
    expiresInDays?: number;
  }): Promise<{ transfer: { id: string; slug: string; expiresAt: string; maxBytes: number } } & UploadTargets> {
    return this.request('POST', '/transfers', input);
  }

  getTransfer(id: string): Promise<{
    transfer: Transfer;
    files: TransferFile[];
    recipients: RecipientStatus[];
  }> {
    return this.request('GET', `/transfers/${enc(id)}`);
  }

  /**
   * Send it. Omit `recipients` for a link-only transfer, which costs nothing
   * from the daily email budget.
   *
   * Idempotent server-side, so a lost response is safe to repeat.
   */
  finalizeTransfer(
    id: string,
    input: { recipients?: string[]; message?: string; password?: string; title?: string } = {},
  ): Promise<{ transfer: Transfer; notified: string[] }> {
    return this.request('POST', `/transfers/${enc(id)}/finalize`, input, { idempotent: true });
  }

  addTransferFiles(id: string, files: FileInput[]): Promise<UploadTargets> {
    return this.request('POST', `/transfers/${enc(id)}/files`, { files });
  }

  removeTransferFile(id: string, fileId: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/transfers/${enc(id)}/files/${enc(fileId)}`);
  }

  updateTransfer(
    id: string,
    input: { expiresInDays?: number; maxDownloads?: number | null },
  ): Promise<{ transfer: Transfer }> {
    return this.request('PATCH', `/transfers/${enc(id)}`, input);
  }

  /** Immediate and irreversible — the encryption keys are destroyed. */
  revokeTransfer(id: string): Promise<{ transfer: Transfer }> {
    return this.request('DELETE', `/transfers/${enc(id)}`);
  }

  transferDownloads(id: string): Promise<{
    downloads: DownloadEvent[];
    recipients: RecipientStatus[];
    totalDownloads: number;
  }> {
    return this.request('GET', `/transfers/${enc(id)}/downloads`);
  }

  // ── Collections ───────────────────────────────────────────────────────────

  listCollections(): Promise<{ collections: CollectionSummary[] }> {
    return this.request('GET', '/collections');
  }

  createCollection(input: { title: string; description?: string }): Promise<{ collection: Collection }> {
    return this.request('POST', '/collections', input);
  }

  getCollection(id: string): Promise<{ collection: Collection }> {
    return this.request('GET', `/collections/${enc(id)}`);
  }

  updateCollection(
    id: string,
    input: { title?: string; description?: string },
  ): Promise<{ collection: Collection }> {
    return this.request('PATCH', `/collections/${enc(id)}`, input);
  }

  deleteCollection(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/collections/${enc(id)}`);
  }

  /** `folderId` omitted lists everything; `'root'` lists the top level only. */
  listCollectionFiles(id: string, folderId?: string): Promise<{ files: CollectionFile[] }> {
    const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : '';
    return this.request('GET', `/collections/${enc(id)}/files${query}`);
  }

  addCollectionFiles(
    id: string,
    files: FileInput[],
    folderId?: string | null,
  ): Promise<UploadTargets> {
    return this.request('POST', `/collections/${enc(id)}/files`, { files, folderId });
  }

  deleteCollectionFiles(id: string, fileIds: string[]): Promise<{ deleted: number }> {
    return this.request('DELETE', `/collections/${enc(id)}/files`, { fileIds });
  }

  listFolders(id: string): Promise<{ folders: Folder[] }> {
    return this.request('GET', `/collections/${enc(id)}/folders`);
  }

  createFolder(
    id: string,
    input: { name: string; parentId?: string | null },
  ): Promise<{ folder: Folder }> {
    return this.request('POST', `/collections/${enc(id)}/folders`, input);
  }

  listGuests(id: string): Promise<{ guests: Guest[] }> {
    return this.request('GET', `/collections/${enc(id)}/guests`);
  }

  inviteGuests(id: string, emails: string[]): Promise<{ invited: string[] }> {
    return this.request('POST', `/collections/${enc(id)}/guests`, { emails });
  }

  removeGuest(id: string, guestId: string): Promise<{ removed: boolean }> {
    return this.request('DELETE', `/collections/${enc(id)}/guests/${enc(guestId)}`);
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  listContacts(): Promise<{ contacts: Contact[] }> {
    return this.request('GET', '/contacts');
  }

  createContact(input: ContactInput): Promise<{ contact: Contact }> {
    return this.request('POST', '/contacts', input);
  }

  getContact(id: string): Promise<{ contact: Contact }> {
    return this.request('GET', `/contacts/${enc(id)}`);
  }

  /** A full replacement: any field omitted is cleared. */
  updateContact(id: string, input: ContactInput): Promise<{ contact: Contact }> {
    return this.request('PATCH', `/contacts/${enc(id)}`, input);
  }

  deleteContact(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/contacts/${enc(id)}`);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /**
   * `idempotent` widens what may be retried.
   *
   * GET and DELETE are safe by nature. POST is not — retrying `createTransfer`
   * after a 500 would make a second draft — so it is opt-in per method, and set
   * only where the server documents the operation as repeatable. Retrying a
   * *throttle* is always fine regardless: a 429 means nothing happened.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { idempotent?: boolean },
  ): Promise<T> {
    const safe = method === 'GET' || method === 'DELETE' || opts?.idempotent === true;
    let attempt = 0;

    for (;;) {
      const res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (res.ok) return (await res.json()) as T;

      const error = await toError(res);
      // A 429 is always retryable — the request was refused, not performed.
      const mayRetry = error.status === 429 || (safe && error.retryable);
      if (!mayRetry || attempt >= this.maxRetries) throw error;

      await sleep(backoffMs(attempt, error));
      attempt++;
    }
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

async function toError(res: Response): Promise<YungleApiError> {
  let body: { error?: YungleErrorBody } | null = null;
  try {
    body = (await res.json()) as { error?: YungleErrorBody };
  } catch {
    // A non-JSON error body means something in front of the app answered — a
    // proxy, a load balancer, an outage page. Still worth surfacing as one.
  }
  const err = body?.error;
  return new YungleApiError(
    res.status,
    err?.code ?? 'http_error',
    err?.message ?? `Request failed with status ${res.status}.`,
    err?.details,
  );
}

/**
 * Honour `Retry-After` when the server sent one, otherwise back off
 * exponentially with a little jitter — several clients throttled at the same
 * moment must not all come back at the same moment.
 */
function backoffMs(attempt: number, error: YungleApiError): number {
  const stated = error.retryAfterSeconds;
  if (stated !== null) return stated * 1000;
  return Math.min(2 ** attempt * 500, 8000) + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

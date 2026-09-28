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
  PulledWebhookEvent,
  RecipientStatus,
  Transfer,
  TransferFile,
  TransferSummary,
  UploadTargets,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventType,
} from './types';

import { renewUploadToken as renewAt, type RenewOutcome as Renewal } from './upload-token';

export * from './types';
export {
  createTokenKeeper,
  renewDelayMs,
  renewUploadToken,
  tokenExpiry,
  type RenewOutcome,
  type TokenKeeper,
  type TokenKeeperDeps,
} from './upload-token';

/**
 * A typed client for the Yungle API.
 *
 * Deliberately dependency-free and built on `fetch`, so it runs unchanged in
 * Node 22, Bun, Deno and a server-side edge runtime. The CLI and the MCP server
 * are both thin layers over this — which is the point: one place understands
 * the wire format, so neither can drift from the other.
 *
 * `createTransfer` and `addCollectionFiles` return a tus endpoint and
 * per-file tokens. `createTokenKeeper` + `renewUploadToken` keep a token alive
 * past its two hours, which any upload longer than that needs.
 */

export interface YungleErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** A link to the explanation of `code` and what to do about it. */
  docs?: string;
}

export interface YungleApiErrorExtras {
  /** `error.docs` from the body: where `code` is explained. */
  docs?: string;
  /** The `Retry-After` header, in seconds, when the server sent one. */
  retryAfterHeader?: number;
}

/**
 * A failed request. Carries the machine-readable `code` — branch on that, never
 * on `message`, which is written for a human reading a log and may change.
 */
export class YungleApiError extends Error {
  /** Where `code` is explained, with what to do about it. Absent on older servers. */
  readonly docs?: string;
  private readonly retryAfterHeader?: number;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    extras: YungleApiErrorExtras = {},
  ) {
    super(message);
    this.name = 'YungleApiError';
    if (extras.docs !== undefined) this.docs = extras.docs;
    if (extras.retryAfterHeader !== undefined) this.retryAfterHeader = extras.retryAfterHeader;
  }

  /** Worth trying again: throttled, or our fault. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /**
   * Seconds to wait, when the server said — in the body's
   * `details.retryAfterSeconds` or, failing that, the `Retry-After` header.
   *
   * The header matters on its own: the monthly-allowance 429 states its wait
   * (an hour) only there, and reading the body alone sent clients back in half
   * a second to be refused again.
   */
  get retryAfterSeconds(): number | null {
    const value = this.details?.retryAfterSeconds;
    if (typeof value === 'number') return value;
    return this.retryAfterHeader ?? null;
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
  /**
   * Sent as `User-Agent`. The CLI and the MCP server set their own; anything
   * else is reported as this package, so Yungle can tell integrations apart.
   */
  userAgent?: string;
}

const DEFAULT_BASE = 'https://yungle.co/api/v1';

export interface PageOptions {
  /** Page size. The server's default applies when omitted. */
  limit?: number;
  /** The `nextCursor` from the previous page, unchanged. */
  cursor?: string;
}

function pageQuery(page: PageOptions, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (page.limit !== undefined) params.set('limit', String(page.limit));
  if (page.cursor) params.set('cursor', page.cursor);
  const q = params.toString();
  return q ? `?${q}` : '';
}

// Replaced with the package version by the build; `dev` under tsx and in tests.
declare const __YUNGLE_CLIENT_VERSION__: string | undefined;
export const CLIENT_VERSION =
  typeof __YUNGLE_CLIENT_VERSION__ === 'string' ? __YUNGLE_CLIENT_VERSION__ : 'dev';

export class YungleClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: ClientOptions) {
    if (!options.apiKey) throw new Error('An API key is required.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 3;
    this.userAgent = options.userAgent ?? `yungle-client/${CLIENT_VERSION}`;
  }

  /** The site root this client talks to (`https://yungle.co`), for the few endpoints outside `/api/v1`. */
  get origin(): string {
    return this.baseUrl.replace(/\/api\/v1$/, '');
  }

  /**
   * Trade a still-valid upload token for a fresh one (two more hours). Returns
   * `'final'` when the token is dead or the upload finished, `'retry'` on a
   * transient failure. `createTokenKeeper(token, { renew: (t) => client.renewUploadToken(t) })`
   * schedules this for you.
   */
  renewUploadToken(token: string): Promise<Renewal> {
    return renewAt(this.origin, token, this.doFetch);
  }

  // ── Account ───────────────────────────────────────────────────────────────

  me(): Promise<Me> {
    return this.request('GET', '/me');
  }

  // ── Transfers ─────────────────────────────────────────────────────────────

  /**
   * One page of transfers, newest first — 100 by default, up to 500. Pass the
   * returned `nextCursor` back as `cursor` for the next page; it is null on the
   * last one. `allTransfers()` does the walking for you.
   */
  listTransfers(page: PageOptions = {}): Promise<{ transfers: TransferSummary[]; nextCursor: string | null }> {
    return this.request('GET', `/transfers${pageQuery(page)}`);
  }

  /** Every transfer, newest first, fetched a page at a time as you iterate. */
  async *allTransfers(pageSize = 500): AsyncGenerator<TransferSummary> {
    let cursor: string | undefined;
    do {
      const page = await this.listTransfers({ limit: pageSize, cursor });
      yield* page.transfers;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
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

  /**
   * `folderId` omitted lists everything; `'root'` lists the top level only.
   * Without `page.limit` the whole collection comes back in one response; with
   * it, follow `nextCursor` (or use `allCollectionFiles`).
   */
  listCollectionFiles(
    id: string,
    folderId?: string,
    page: PageOptions = {},
  ): Promise<{ files: CollectionFile[]; nextCursor: string | null }> {
    const query = pageQuery(page, folderId ? { folderId } : {});
    return this.request('GET', `/collections/${enc(id)}/files${query}`);
  }

  /** Every file in a collection, oldest first, a page at a time. */
  async *allCollectionFiles(id: string, folderId?: string, pageSize = 1000): AsyncGenerator<CollectionFile> {
    let cursor: string | undefined;
    do {
      const page = await this.listCollectionFiles(id, folderId, { limit: pageSize, cursor });
      yield* page.files;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
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

  // ── Webhooks ──────────────────────────────────────────────────────────────

  listWebhooks(): Promise<{ webhooks: WebhookEndpoint[] }> {
    return this.request('GET', '/webhooks');
  }

  /** `url: null` makes a pull endpoint. The `secret` is returned here only. */
  createWebhook(input: {
    url: string | null;
    events: WebhookEventType[];
    description?: string;
  }): Promise<{ webhook: WebhookEndpoint; secret: string }> {
    return this.request('POST', '/webhooks', input);
  }

  getWebhook(id: string): Promise<{ webhook: WebhookEndpoint }> {
    return this.request('GET', `/webhooks/${enc(id)}`);
  }

  updateWebhook(
    id: string,
    input: { url?: string | null; events?: WebhookEventType[]; description?: string | null; enabled?: boolean },
  ): Promise<{ webhook: WebhookEndpoint }> {
    return this.request('PATCH', `/webhooks/${enc(id)}`, input);
  }

  deleteWebhook(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/webhooks/${enc(id)}`);
  }

  rotateWebhookSecret(id: string): Promise<{ secret: string }> {
    return this.request('POST', `/webhooks/${enc(id)}/rotate-secret`);
  }

  testWebhook(id: string): Promise<{ deliveryId: string }> {
    return this.request('POST', `/webhooks/${enc(id)}/test`);
  }

  listWebhookDeliveries(id: string): Promise<{ deliveries: WebhookDelivery[] }> {
    return this.request('GET', `/webhooks/${enc(id)}/deliveries`);
  }

  retryWebhookDelivery(id: string, deliveryId: string): Promise<{ queued: boolean }> {
    return this.request('POST', `/webhooks/${enc(id)}/deliveries/${enc(deliveryId)}/retry`);
  }

  /**
   * An endpoint's events, oldest first, after `cursor`. `nextCursor` comes back
   * even when nothing is new, so keep the latest and poll with it.
   */
  listWebhookEvents(
    id: string,
    page: PageOptions = {},
  ): Promise<{ events: PulledWebhookEvent[]; nextCursor: string | null; hasMore: boolean }> {
    return this.request('GET', `/webhooks/${enc(id)}/events${pageQuery(page)}`);
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
   * What may be retried after a 5xx or a lost connection.
   *
   * GET and DELETE are safe by nature. A POST is safe because it carries an
   * `Idempotency-Key` (see below). PATCH is not retried. Retrying a *throttle*
   * is always fine regardless: a 429 means nothing happened.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { idempotent?: boolean },
  ): Promise<T> {
    /**
     * Every POST carries an Idempotency-Key, minted once and reused on every
     * retry of this call — which is what makes a POST safe to retry at all. A
     * lost response to "create transfer" used to mean a second draft; now the
     * retry gets the first one back.
     */
    const idempotencyKey = method === 'POST' ? globalThis.crypto.randomUUID() : undefined;
    const safe = method === 'GET' || method === 'DELETE' || idempotencyKey !== undefined || opts?.idempotent === true;
    let attempt = 0;

    for (;;) {
      const res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
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
  const retryAfterHeader = parseRetryAfter(res.headers.get('retry-after'));
  return new YungleApiError(
    res.status,
    err?.code ?? 'http_error',
    err?.message ?? `Request failed with status ${res.status}.`,
    err?.details,
    {
      ...(typeof err?.docs === 'string' ? { docs: err.docs } : {}),
      ...(retryAfterHeader === null ? {} : { retryAfterHeader }),
    },
  );
}

/**
 * `Retry-After` is delay-seconds or an HTTP-date (RFC 9110 §10.2.3). Anything
 * else — including a negative number or a date already past — is no statement.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds >= 0 ? seconds : null;
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

/**
 * Check a webhook's `Yungle-Signature` header against the RAW request body.
 *
 * WebCrypto rather than `node:crypto`, so it runs wherever this client does:
 * Node, Bun, Deno and edge runtimes. Rejects a timestamp more than
 * `toleranceSeconds` away, which is what stops a captured request being replayed.
 */
export async function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  { toleranceSeconds = 300, now = Date.now() }: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > toleranceSeconds || !parts.v1) return false;
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

/**
 * The wire shapes `/api/v1` emits.
 *
 * Hand-written rather than generated, and deliberately **not** imported by
 * `apps/web`. Two reasons, both practical:
 *
 *  - Having the server import this package would put it in the web app's
 *    dependency graph, which means a `COPY packages/api-client/package.json`
 *    line in two Dockerfiles for something production never runs. The cost of
 *    forgetting that line is an image build failure, not a test failure.
 *  - The server's own definitions live in `lib/api/serialize.ts` and are the
 *    authority. These are a client's *reading* of the contract.
 *
 * Drift is managed by the OpenAPI document at `/api/v1/openapi.json`, which is
 * generated from the server's Zod schemas — and by both sides living in one
 * repo and shipping in one commit. If this package ever gains a second consumer
 * outside the repo, generate it from the spec instead.
 */

export type Iso8601 = string;

export interface Workspace {
  id: string;
  email: string | null;
  displayName: string | null;
  /** The workspace's verified custom domain, or null. */
  customDomain: string | null;
}

export interface PlanInfo {
  tier: string | null;
  name: string | null;
  status: string;
  quotaBytes: number;
  usedBytes: number;
}

export interface KeyInfo {
  id: string;
  name: string;
  scopes: string[];
  /** Absent on servers before 2026-09-26. */
  via?: 'key' | 'oauth';
  /** Whether this credential may make Yungle email anyone. Absent on older servers. */
  canEmail?: boolean;
}

/** Your invite code and what it has earned (`GET /me/referral`). */
export interface Referral {
  /** Your invite code. A friend can type it in Settings › Plan. */
  code: string;
  /** Your invite link: the same code, as a page that signs them up. */
  url: string;
  /** Free months earned so far. */
  earnedMonths: number;
  /** Free months still available to earn. */
  remainingMonths: number;
  /** The most free months one person can earn, ever. */
  cap: number;
  /** True once `earnedMonths` reached `cap`. The link still gives friends their month. */
  capped: boolean;
  /** Friends in their free month, or inside the 14 days after their first payment. */
  pending: number;
}

export interface Me {
  workspace: Workspace;
  plan: PlanInfo;
  key: KeyInfo;
}

/** What you send when registering a file for upload. */
export interface FileInput {
  name: string;
  size: number;
  type?: string;
  /** Directory inside an uploaded folder, e.g. `Ceremony/Raw`. */
  path?: string;
}

/** Where to put the bytes, and the token that authorizes every tus request. */
export interface UploadTarget {
  id: string;
  name: string;
  size: number;
  uploadToken: string;
  /**
   * When `uploadToken` stops working (two hours after issue). Renew before then
   * with `renewUploadToken` — or let `createTokenKeeper` do it — for any upload
   * that may run longer. Absent from servers older than 2026-09-29.
   */
  uploadTokenExpiresAt?: string;
}

export interface UploadTargets {
  tusEndpoint: string;
  /** One per `files` entry, in order. */
  files: UploadTarget[];
  /** One per `imports` entry, in order. Absent from servers before 2026-09-29. */
  imports?: ImportStarted[];
}

/**
 * A file for Yungle to fetch from a URL itself, so the bytes never pass
 * through you — a presigned S3 link, a CDN, a release asset. The source must
 * state the size (Content-Length or a Range answer).
 */
export interface ImportInput {
  url: string;
  /** Defaults to the name the source gives. */
  name?: string;
  /** Folder to place it in. */
  path?: string;
}

export interface ImportStarted {
  fileId: string;
  name: string;
  size: number;
  /** The source's host; never the full URL. */
  source: string;
  status: 'queued';
}

/** Where one import stands (`getImport`). */
export interface ImportStatus {
  fileId: string;
  name: string;
  size: number;
  /** Committed so far; moves in steps of one storage part. */
  receivedBytes: number;
  source: string | null;
  status: 'importing' | 'ready' | 'failed';
  error: string | null;
}

export interface Transfer {
  id: string;
  slug: string;
  url: string;
  title: string | null;
  status: string;
  sizeBytes: number;
  fileCount?: number;
  recipients: string[];
  hasPassword: boolean;
  /**
   * End-to-end encrypted: the working link carries a key Yungle never holds,
   * so `url` alone does not open it. Absent on servers before 2026-09-29.
   */
  e2ee?: boolean;
  downloadCount: number;
  maxDownloads: number | null;
  /** Null while it is still a draft. A draft is not shareable. */
  finalizedAt: Iso8601 | null;
  /** Every transfer expires; a paid plan chooses when. */
  expiresAt: Iso8601;
  createdAt: Iso8601;
}

export interface TransferSummary extends Omit<Transfer, 'hasPassword' | 'fileCount'> {
  fileCount: number;
  firstFileName: string | null;
}

export interface TransferFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  path: string | null;
  /** Null until the malware scan finishes, then `clean` or `infected`. */
  scanResult: string | null;
  /** CRC-32 of the bytes (IEEE, as `zlib.crc32`), 8 hex digits; null while unknown. */
  crc32: string | null;
  createdAt: Iso8601;
}

export interface RecipientStatus {
  id: string;
  email: string;
  notifiedAt: Iso8601 | null;
  downloaded: boolean;
  /**
   * @deprecated Always false since 2026-09-26: Yungle no longer records whether
   * a recipient opened the page — only whether they downloaded.
   */
  opened: boolean;
  /**
   * Set when mail to this address permanently failed. Additive since 2026-09;
   * clients that predate it are unaffected.
   */
  bouncedAt: Iso8601 | null;
  /** 'hard_bounce' | 'blocked' | 'refused', or null. */
  bounceKind: string | null;
}

export interface DownloadEvent {
  id: string;
  /** Null means the whole-transfer zip rather than one file. */
  fileName: string | null;
  recipientEmail: string | null;
  /** One page visit is one download; several files in it share this. */
  sessionId: string;
  /** Always null since 2026-09 — the truncated IP is no longer recorded. */
  ipTruncated: string | null;
  createdAt: Iso8601;
}

export interface Collection {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  visibility: string;
  /** The secret link. Null only for rows created before it was minted eagerly. */
  url: string | null;
  customLink: boolean;
  sizeBytes: number;
  coverFileId: string | null;
  expiresAt: Iso8601 | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
  fileCount?: number;
}

export interface CollectionSummary {
  id: string;
  title: string;
  slug: string;
  visibility: string;
  fileCount: number;
  sizeBytes: number;
  coverFileId: string | null;
  updatedAt: Iso8601;
}

export interface CollectionFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  folderId: string | null;
  hasThumbnail: boolean;
  /** CRC-32 of the bytes (IEEE, as `zlib.crc32`), 8 hex digits; null while unknown. */
  crc32: string | null;
  createdAt: Iso8601;
}

export interface Folder {
  id: string;
  name: string;
  /** Materialized, e.g. `/Ceremony/Raw`. */
  path: string;
  parentId: string | null;
  depth: number;
}

export interface Guest {
  id: string;
  email: string;
  status: string;
}

export interface Contact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  email: string;
  phone: string | null;
  type: string;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface ContactInput {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  email: string;
  phone?: string | null;
  type?: string | null;
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export type WebhookEventType =
  | 'transfer.ready'
  | 'transfer.downloaded'
  | 'transfer.expiring'
  | 'transfer.expired'
  | 'collection.file_uploaded'
  | 'request.submitted';

export interface WebhookEndpoint {
  id: string;
  /** Null for a pull endpoint. */
  url: string | null;
  mode: 'push' | 'pull';
  description: string | null;
  events: WebhookEventType[];
  enabled: boolean;
  disabledReason: 'failing' | 'user' | null;
  lastSuccessAt: Iso8601 | null;
  lastFailureAt: Iso8601 | null;
  createdAt: Iso8601;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  type: WebhookEventType | 'webhook.test';
  status: 'pending' | 'succeeded' | 'failed' | 'available';
  attempts: number;
  nextAttemptAt: Iso8601 | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: Iso8601 | null;
  createdAt: Iso8601;
}

/** The JSON a push delivery sends, and what `/events` returns (plus `deliveryId`). */
export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType | 'webhook.test';
  createdAt: Iso8601;
  data: T;
}

/** An event read from `/webhooks/{id}/events`: the push payload plus the cursor to resume from. */
export type PulledWebhookEvent<T = Record<string, unknown>> = WebhookEvent<T> & {
  /** Pass the last one back as `cursor`. */
  deliveryId: string;
};

/** One file in a set of download links. */
export interface DownloadLink {
  id: string;
  /** For an end-to-end encrypted transfer, a placeholder; the real name is sealed in `e2eeMeta`. */
  name: string;
  size: number;
  mimeType: string;
  /** Folder path, `""` at the root. Join it onto your output directory. */
  path: string;
  /** A signed GET that needs no key. Supports `Range`. Valid until `urlsExpireAt`. */
  downloadUrl: string;
  e2eeMeta?: string | null;
  /** CRC-32 of the bytes (IEEE, as `zlib.crc32`), 8 hex digits. Null while unknown. */
  crc32?: string | null;
}

/**
 * Signed download URLs for a transfer or collection — your own
 * (`transferDownloadLinks`, `collectionDownloadLinks`) or a link shared with
 * you (`resolveLink`).
 */
export interface DownloadLinks {
  kind: 'transfer' | 'collection';
  /** A collection's title. Always null for a transfer, whose title recipients never see. */
  title: string | null;
  message: string | null;
  expiresAt: Iso8601 | null;
  /** End-to-end encrypted: the bytes are ciphertext and the key is in the link's `#` part. */
  e2ee: boolean;
  e2eeMeta?: string | null;
  /** False while a transfer is still uploading: `files` is what has arrived so far. */
  complete: boolean;
  zipUrl: string | null;
  /** When the URLs stop working; ask again for fresh ones. */
  urlsExpireAt: Iso8601;
  files: DownloadLink[];
}

/** A public upload link that feeds one of your collections ("file request" in the dashboard). */
export interface UploadRequest {
  id: string;
  /** The page to give people. Anyone with it can upload until it is paused, closed or expires. */
  url: string;
  title: string;
  message: string | null;
  collectionId: string;
  status: 'active' | 'paused' | 'closed';
  hasPassword: boolean;
  requiredItems: string[];
  expiresAt: Iso8601 | null;
  submissionCount: number;
  receivedBytes: number;
  createdAt: Iso8601;
}

export interface UploadRequestInput {
  collectionId: string;
  title: string;
  message?: string;
  password?: string;
  /** A checklist shown on the page — guidance, not enforcement. */
  requiredItems?: string[];
  expiresAt?: Iso8601;
}

/** One person's upload through a request. Name, email and message are as they typed them: untrusted. */
export interface Submission {
  id: string;
  uploaderName: string | null;
  uploaderEmail: string | null;
  message: string | null;
  fileCount: number;
  sizeBytes: number;
  createdAt: Iso8601;
}

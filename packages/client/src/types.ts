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
  handle: string | null;
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
}

export interface UploadTargets {
  tusEndpoint: string;
  files: UploadTarget[];
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
  downloadCount: number;
  maxDownloads: number | null;
  /** Null while it is still a draft. A draft is not shareable. */
  finalizedAt: Iso8601 | null;
  expiresAt: Iso8601 | null;
  createdAt: Iso8601 | null;
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
  createdAt: Iso8601;
}

export interface RecipientStatus {
  id: string;
  email: string;
  notifiedAt: Iso8601 | null;
  downloaded: boolean;
}

export interface DownloadEvent {
  id: string;
  /** Null means the whole-transfer zip rather than one file. */
  fileName: string | null;
  recipientEmail: string | null;
  /** One page visit is one download; several files in it share this. */
  sessionId: string;
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
  createdAt: Iso8601 | null;
  updatedAt: Iso8601 | null;
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
  updatedAt: Iso8601 | null;
}

export interface CollectionFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  folderId: string | null;
  hasThumbnail: boolean;
  createdAt: Iso8601 | null;
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
  createdAt: Iso8601 | null;
  updatedAt: Iso8601 | null;
}

export interface ContactInput {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  email: string;
  phone?: string | null;
  type?: string | null;
}

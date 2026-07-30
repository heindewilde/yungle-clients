import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the CLI keeps its key and its resume state.
 *
 * XDG paths with a `~/.config` fallback, because a config file that lands
 * somewhere unexpected is a support question forever. Resume state goes under
 * the *cache* directory rather than config: it is reconstructible, it can be
 * deleted at any time without breaking anything, and putting a growing scratch
 * file in a directory people back up is rude.
 */

function xdg(envVar: string, fallback: string): string {
  const configured = process.env[envVar];
  return configured && configured.startsWith('/') ? configured : join(homedir(), fallback);
}

export const CONFIG_PATH = join(xdg('XDG_CONFIG_HOME', '.config'), 'yungle', 'config.json');
export const RESUME_PATH = join(xdg('XDG_CACHE_HOME', '.cache'), 'yungle', 'uploads.json');

export interface Config {
  apiKey?: string;
  baseUrl?: string;
}

export async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return {};
  }
}

/**
 * Written 0600 — the file *is* a credential, and a key readable by every user
 * on a shared build machine is the whole risk this is meant to bound. `chmod`
 * runs after the write rather than relying on `mode` alone, because `mode` is
 * masked by `umask` and a permissive umask would silently widen it.
 */
export async function writeConfig(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
}

/**
 * The key in force, and where it came from.
 *
 * The environment wins over the config file so CI can set `YUNGLE_API_KEY`
 * without a login step, and so a developer can run one command against another
 * workspace without disturbing their saved key.
 */
export async function resolveKey(): Promise<{ apiKey: string; baseUrl?: string; source: string } | null> {
  const fromEnv = process.env.YUNGLE_API_KEY?.trim();
  const config = await readConfig();
  const baseUrl = process.env.YUNGLE_API_URL?.trim() || config.baseUrl;

  if (fromEnv) return { apiKey: fromEnv, baseUrl, source: 'YUNGLE_API_KEY' };
  if (config.apiKey) return { apiKey: config.apiKey, baseUrl, source: CONFIG_PATH };
  return null;
}

// ── Resume state ────────────────────────────────────────────────────────────

/**
 * An interrupted upload session, so re-running the same command continues it.
 *
 * The first version stored `fileId → tus URL` and was **useless**, in a way
 * that looked like it worked: it persisted correctly and was cleared correctly,
 * but `yungle send` registers a fresh set of file rows on every invocation, so
 * the next run had new ids and never looked at the stored ones. Resume only
 * ever applied inside one process — which tus already handles by itself, and
 * which is not the case the feature exists for.
 *
 * Surviving a `kill -9` means remembering the whole session and keying it on
 * something the *next* invocation can reproduce from its arguments alone:
 * the local files themselves.
 */
export interface UploadSession {
  /** Epoch ms. Sessions expire with their upload tokens — see SESSION_TTL_MS. */
  createdAt: number;
  kind: 'transfer' | 'collection';
  /** The draft being built, or the collection being filled. */
  targetId: string;
  tusEndpoint: string;
  files: { path: string; id: string; name: string; size: number; uploadToken: string }[];
}

/**
 * How long a session is worth resuming.
 *
 * Two hours, because that is `UPLOAD_TOKEN_TTL_MS` on the server — the tokens
 * in a stored session are exactly as dead as the session is. Offering to resume
 * past that would replace a clean "starting fresh" with a 401 partway through.
 */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export type SessionMap = Record<string, UploadSession>;

/**
 * Identity for a batch of local files.
 *
 * Path, size and mtime of every input, plus what it is being uploaded into.
 * Deliberately *not* content hashes: reading 400 GB to decide whether to resume
 * defeats the point. Deliberately *including* mtime, so editing a file between
 * runs starts over rather than resuming into a row whose declared size no
 * longer matches — the server would reject the finished upload and the error
 * would point nowhere useful.
 *
 * The parts are serialized as JSON rather than joined with separator
 * characters. The first version built `path:size:mtime` strings joined with
 * `|`, both of which a filename may legally contain: one file at
 * `/a:10:1700000000000|/b` hashed identically to the two files `/a` and `/b`
 * with that size and mtime, so the CLI would resume the wrong session and
 * stream one file's bytes into another's row. Contrived, and caught by a test
 * rather than by a user, but unambiguous encoding costs nothing.
 */
export function sessionKey(
  inputs: { path: string; size: number; mtimeMs: number }[],
  target: string,
): string {
  const parts = inputs
    .map((f) => [f.path, f.size, Math.floor(f.mtimeMs)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify([target, parts])).digest('hex').slice(0, 32);
}

export async function readSessions(): Promise<SessionMap> {
  try {
    const parsed = JSON.parse(await readFile(RESUME_PATH, 'utf8')) as SessionMap;
    // Drop anything whose upload tokens have expired as we read, so the file
    // cannot grow without bound on a machine that abandons uploads often.
    const now = Date.now();
    const live: SessionMap = {};
    for (const [key, session] of Object.entries(parsed)) {
      if (session && now - session.createdAt < SESSION_TTL_MS) live[key] = session;
    }
    return live;
  } catch {
    return {};
  }
}

export async function findSession(key: string): Promise<UploadSession | null> {
  return (await readSessions())[key] ?? null;
}

export async function saveSession(key: string, session: UploadSession): Promise<void> {
  const sessions = await readSessions();
  sessions[key] = session;
  await mkdir(dirname(RESUME_PATH), { recursive: true });
  await writeFile(RESUME_PATH, JSON.stringify(sessions));
}

export async function dropSession(key: string): Promise<void> {
  const sessions = await readSessions();
  if (!(key in sessions)) return;
  delete sessions[key];
  await mkdir(dirname(RESUME_PATH), { recursive: true });
  await writeFile(RESUME_PATH, JSON.stringify(sessions));
}

// ── tus upload URLs ─────────────────────────────────────────────────────────

/**
 * Where each file's tus upload got to, keyed by server file id.
 *
 * Stored beside the sessions and only meaningful with one: an upload URL alone
 * authorizes nothing (the server verifies the signed token on every method),
 * and without the session it belongs to there is no way to know what it was
 * uploading.
 */
export type UrlMap = Record<string, string>;

const URL_PATH = RESUME_PATH.replace(/uploads\.json$/, 'upload-urls.json');

export async function readUploadUrls(): Promise<UrlMap> {
  try {
    return JSON.parse(await readFile(URL_PATH, 'utf8')) as UrlMap;
  } catch {
    return {};
  }
}

export async function saveUploadUrl(fileId: string, uploadUrl: string): Promise<void> {
  const current = await readUploadUrls();
  if (current[fileId] === uploadUrl) return;
  current[fileId] = uploadUrl;
  await mkdir(dirname(URL_PATH), { recursive: true });
  await writeFile(URL_PATH, JSON.stringify(current));
}

export async function clearUploadUrls(fileIds: string[]): Promise<void> {
  const current = await readUploadUrls();
  let changed = false;
  for (const id of fileIds) {
    if (id in current) {
      delete current[id];
      changed = true;
    }
  }
  if (changed) await writeFile(URL_PATH, JSON.stringify(current));
}

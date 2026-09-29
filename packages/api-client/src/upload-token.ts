/**
 * Keeps an upload token fresh for as long as an upload runs.
 *
 * Upload tokens live two hours and every tus request presents one, so an
 * upload that outlasts its token — a big file on a home connection — dies at
 * the first request after expiry: the next PATCH of a chunked client, or the
 * HEAD a dropped connection resumes with. The keeper trades the token for a
 * fresh one (`POST /api/uploads/token`) once half its remaining life is gone,
 * which also tells the server the upload is alive (its quota stays reserved and
 * recipients keep seeing "still arriving").
 *
 * Pure apart from the injected clock, timer and `renew`, so the schedule tests
 * on the fast rung. The same rule lives in the web app's browser uploader
 * (`apps/web/lib/upload-token-keeper.ts` in the Yungle repo) and the Python SDK.
 */

/** A renewal attempt: the new token, `'final'` (stop — the upload is over or the token dead), or `'retry'`. */
export type RenewOutcome = { token: string; expiresAt: number } | 'final' | 'retry';

export interface TokenKeeperDeps {
  renew: (current: string) => Promise<RenewOutcome>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Never renew more often than this, however short the remaining life. */
export const MIN_RENEW_DELAY_MS = 60_000;
/** After a failed attempt (offline, 5xx), try again this soon. */
export const RETRY_DELAY_MS = 60_000;

/** `exp` (epoch ms) from a signed token's payload, or null if it has none. */
export function tokenExpiry(token: string): number | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    const b64 = token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

/**
 * How long to wait before renewing a token that expires at `expiresAt`: half
 * the remaining life, floored at a minute. Half, not "five minutes before",
 * because a laptop that sleeps through the renewal time wakes up with the
 * other half still to spend on a retry.
 */
export function renewDelayMs(expiresAt: number, now: number): number {
  return Math.max(MIN_RENEW_DELAY_MS, Math.floor((expiresAt - now) / 2));
}

export interface TokenKeeper {
  /** The token to send on the next request. */
  current(): string;
  /** Stop renewing (the upload finished, failed or was cancelled). */
  stop(): void;
}

export function createTokenKeeper(initial: string, deps: TokenKeeperDeps): TokenKeeper {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let token = initial;
  let expiresAt = tokenExpiry(initial);
  let stopped = false;
  let handle: unknown = null;

  const schedule = (ms: number) => {
    if (stopped) return;
    handle = setTimer(() => void attempt(), ms);
  };

  const attempt = async () => {
    if (stopped) return;
    let outcome: RenewOutcome;
    try {
      outcome = await deps.renew(token);
    } catch {
      outcome = 'retry';
    }
    if (stopped) return;
    if (outcome === 'final') {
      stopped = true;
      return;
    }
    if (outcome === 'retry') {
      // Past expiry a retry cannot succeed — the server refuses dead tokens.
      if (expiresAt !== null && now() >= expiresAt) {
        stopped = true;
        return;
      }
      schedule(RETRY_DELAY_MS);
      return;
    }
    token = outcome.token;
    expiresAt = outcome.expiresAt;
    schedule(renewDelayMs(expiresAt, now()));
  };

  // A token we cannot read an expiry from is still renewed — hourly.
  schedule(expiresAt === null ? 60 * 60_000 : renewDelayMs(expiresAt, now()));

  return {
    current: () => token,
    stop: () => {
      stopped = true;
      if (handle !== null) clearTimer(handle);
    },
  };
}

/**
 * The HTTP half of a renewal: POST the current token to
 * `<origin>/api/uploads/token`, read the fresh one. 401/404 are final (the
 * token is dead, or the upload is over); anything else is worth a retry.
 *
 * `origin` is the site root (`https://yungle.co`), not the `/api/v1` base: the
 * credential is the upload token, not an API key, so this lives outside v1.
 */
export async function renewUploadToken(
  origin: string,
  current: string,
  doFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<RenewOutcome> {
  const res = await doFetch(`${origin.replace(/\/+$/, '')}/api/uploads/token`, {
    method: 'POST',
    headers: { 'x-yungle-upload-token': current },
  });
  if (res.status === 401 || res.status === 404) return 'final';
  if (!res.ok) return 'retry';
  const body = (await res.json()) as { uploadToken: string; expiresAt: string };
  return { token: body.uploadToken, expiresAt: Date.parse(body.expiresAt) };
}

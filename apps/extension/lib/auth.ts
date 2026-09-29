/**
 * Signing in, keeping the token fresh, signing out.
 *
 * **Refresh is single-flight across every extension context.** The server
 * rotates refresh tokens and treats a refresh token presented twice as stolen:
 * it revokes the whole grant. The popup, the side panel, a compose dialog in
 * Gmail and the background can all want a token at the same moment, so every
 * refresh runs under one Web Lock (shared by all pages of the extension's
 * origin) and re-reads storage inside it — the second caller finds the fresh
 * pair the first one just stored.
 */

import { CLIENT_ID, ORIGIN } from './config';
import { authorizeUrl, challengeFor, isFresh, randomState, randomVerifier, readRedirect, redirectUri, tokensFrom, type Tokens } from './oauth';

const TOKENS_KEY = 'auth';
const PENDING_KEY = 'pendingAuth';
const LOCK = 'yungle-auth';

export class SignedOutError extends Error {
  constructor() {
    super('Signed out');
    this.name = 'SignedOutError';
  }
}

interface Pending {
  verifier: string;
  state: string;
  startedAt: number;
}

/** A sign-in abandoned for this long is forgotten; the server's code lives 10 minutes. */
const PENDING_TTL_MS = 30 * 60_000;

export async function readTokens(): Promise<Tokens | null> {
  const got = await browser.storage.local.get(TOKENS_KEY);
  return (got[TOKENS_KEY] as Tokens | undefined) ?? null;
}

async function writeTokens(t: Tokens | null): Promise<void> {
  if (t) await browser.storage.local.set({ [TOKENS_KEY]: t });
  else await browser.storage.local.remove(TOKENS_KEY);
}

/** Call `listener` whenever the signed-in state changes, in any context. */
export function onAuthChange(listener: (signedIn: boolean) => void): () => void {
  const handler = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && TOKENS_KEY in changes) listener(Boolean(changes[TOKENS_KEY]!.newValue));
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}

// ── Sign in ─────────────────────────────────────────────────────────────────

/**
 * Open the consent page in a tab. The code comes back through `handleTabUrl`,
 * in the background, from whichever tab reaches the redirect page — including
 * one opened from the sign-in email.
 *
 * The verifier lives in `storage.session`: it survives the background being
 * suspended while the person fetches their email, and never reaches disk.
 */
export async function startSignIn(): Promise<void> {
  const verifier = randomVerifier();
  const state = randomState();
  await browser.storage.session.set({ [PENDING_KEY]: { verifier, state, startedAt: Date.now() } satisfies Pending });
  await browser.tabs.create({ url: authorizeUrl(ORIGIN, await challengeFor(verifier), state) });
}

/** Background only: a tab navigated. Returns true when it completed a sign-in. */
export async function handleTabUrl(tabId: number, url: string): Promise<boolean> {
  const got = await browser.storage.session.get(PENDING_KEY);
  const pending = got[PENDING_KEY] as Pending | undefined;
  if (!pending || Date.now() - pending.startedAt > PENDING_TTL_MS) return false;

  const result = readRedirect(url, ORIGIN, pending.state);
  if (result.kind === 'ignore') return false;
  // Spent either way: a state is good for one answer.
  await browser.storage.session.remove(PENDING_KEY);
  if (result.kind === 'denied') return false;

  const res = await fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: result.code,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(ORIGIN),
      code_verifier: pending.verifier,
    }),
  });
  if (!res.ok) return false;
  await writeTokens(tokensFrom(await res.json(), Date.now()));
  // The page says "you can close this"; spare them the click.
  setTimeout(() => void browser.tabs.remove(tabId).catch(() => undefined), 1200);
  return true;
}

// ── Tokens ──────────────────────────────────────────────────────────────────

/** A usable access token, refreshing if needed. Throws `SignedOutError`. */
export async function getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
  return navigator.locks.request(LOCK, async () => {
    const t = await readTokens();
    if (!t) throw new SignedOutError();
    if (!opts.forceRefresh && isFresh(t, Date.now())) return t.accessToken;

    const res = await fetch(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: CLIENT_ID }),
    }).catch(() => null);

    // Offline or a server hiccup is not a sign-out: keep the tokens and let the
    // caller's request fail on its own terms.
    if (!res) throw new Error('offline');
    if (res.status >= 500) throw new Error(`token refresh failed (${res.status})`);
    if (!res.ok) {
      // invalid_grant: revoked in Settings, expired after 30 idle days, or the
      // grant was killed for a replayed token. Only a new sign-in helps.
      await writeTokens(null);
      throw new SignedOutError();
    }
    const fresh = tokensFrom(await res.json(), Date.now());
    await writeTokens(fresh);
    return fresh.accessToken;
  });
}

export async function signOut(): Promise<void> {
  const t = await readTokens();
  await writeTokens(null);
  if (!t) return;
  // Both tokens, best effort: the refresh token so nothing can mint more, the
  // access token so the hour it had left ends now too.
  await Promise.all(
    [t.refreshToken, t.accessToken].map((token) =>
      fetch(`${ORIGIN}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: CLIENT_ID }),
      }).catch(() => undefined),
    ),
  );
}

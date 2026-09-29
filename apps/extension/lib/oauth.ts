/**
 * The OAuth decisions, with no browser APIs — so they are tested in
 * milliseconds. `auth.ts` does the storage, the tabs and the network.
 *
 * The flow: authorization code + PKCE (S256), redirecting to yungle.co's own
 * `/extension/connected`. Not `identity.launchWebAuthFlow`: Yungle signs in by
 * magic link, which finishes in a NEW tab opened from the email, and only a
 * page-watching extension can follow that. The background watches every tab
 * for the redirect page and takes the code from whichever one lands there.
 */

import { CLIENT_ID, SCOPES } from './config';

export const REDIRECT_PATH = '/extension/connected';

export function redirectUri(origin: string): string {
  return `${origin}${REDIRECT_PATH}`;
}

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 43 characters of base64url: the RFC 7636 minimum, from 32 random bytes. */
export function randomVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function authorizeUrl(origin: string, challenge: string, state: string): string {
  const u = new URL('/oauth/authorize', origin);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(origin),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: SCOPES.join(' '),
    state,
  }).toString();
  return u.toString();
}

export type RedirectResult = { kind: 'code'; code: string } | { kind: 'denied' } | { kind: 'ignore' };

/**
 * What a tab's URL means for a sign-in in progress.
 *
 * `ignore` for anything that is not our redirect page, AND for one whose state
 * is not ours: that is someone else's flow (a phished link, a second extension
 * install) and its code is not for us to spend. The issuer is checked too
 * (RFC 9207), which is free here and closes mix-up between a dev and a
 * production origin.
 */
export function readRedirect(url: string, origin: string, expectedState: string | null): RedirectResult {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'ignore' };
  }
  if (u.origin !== origin || u.pathname !== REDIRECT_PATH) return { kind: 'ignore' };
  if (!expectedState || u.searchParams.get('state') !== expectedState) return { kind: 'ignore' };
  const iss = u.searchParams.get('iss');
  if (iss !== null && iss !== origin) return { kind: 'ignore' };
  if (u.searchParams.get('error')) return { kind: 'denied' };
  const code = u.searchParams.get('code');
  return code ? { kind: 'code', code } : { kind: 'ignore' };
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Refresh a minute early, so a request never leaves with a token about to lapse. */
export const REFRESH_SKEW_MS = 60_000;

export function isFresh(t: Tokens, now: number): boolean {
  return t.expiresAt - REFRESH_SKEW_MS > now;
}

export function tokensFrom(body: { access_token: string; refresh_token: string; expires_in: number }, now: number): Tokens {
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: now + body.expires_in * 1000 };
}

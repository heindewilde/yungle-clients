import { describe, expect, it } from 'vitest';
import { authorizeUrl, challengeFor, isFresh, randomVerifier, readRedirect, REFRESH_SKEW_MS, tokensFrom } from './oauth';

const ORIGIN = 'https://yungle.co';

describe('PKCE', () => {
  it('makes a verifier the server accepts (43–128 base64url chars)', () => {
    expect(randomVerifier()).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('derives the RFC 7636 S256 challenge', async () => {
    // Appendix B of RFC 7636.
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('the authorize URL', () => {
  it('asks for exactly the extension’s scopes, with S256 and our redirect page', () => {
    const u = new URL(authorizeUrl(ORIGIN, 'c'.repeat(43), 'st'));
    expect(u.origin + u.pathname).toBe('https://yungle.co/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('yungle-extension');
    expect(u.searchParams.get('redirect_uri')).toBe('https://yungle.co/extension/connected');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('transfers:read transfers:write transfers:send contacts:read');
    expect(u.searchParams.get('state')).toBe('st');
  });
});

describe('reading the redirect', () => {
  const at = (q: string, path = '/extension/connected', origin = ORIGIN) => `${origin}${path}?${q}`;

  it('takes a code only with our state', () => {
    expect(readRedirect(at('code=abc&state=s1&iss=https%3A%2F%2Fyungle.co'), ORIGIN, 's1')).toEqual({ kind: 'code', code: 'abc' });
    expect(readRedirect(at('code=abc&state=OTHER'), ORIGIN, 's1')).toEqual({ kind: 'ignore' });
    expect(readRedirect(at('code=abc&state=s1'), ORIGIN, null)).toEqual({ kind: 'ignore' });
  });

  it('ignores other pages, other origins and a foreign issuer', () => {
    expect(readRedirect(at('code=abc&state=s1', '/dashboard'), ORIGIN, 's1').kind).toBe('ignore');
    expect(readRedirect(at('code=abc&state=s1', '/extension/connected', 'https://evil.example'), ORIGIN, 's1').kind).toBe('ignore');
    expect(readRedirect(at('code=abc&state=s1&iss=http%3A%2F%2Flocalhost%3A3002'), ORIGIN, 's1').kind).toBe('ignore');
    expect(readRedirect('not a url', ORIGIN, 's1').kind).toBe('ignore');
  });

  it('reads a cancel as denied', () => {
    expect(readRedirect(at('error=access_denied&state=s1'), ORIGIN, 's1')).toEqual({ kind: 'denied' });
  });
});

describe('token freshness', () => {
  it('refreshes a minute before expiry', () => {
    const t = tokensFrom({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, 0);
    expect(t.expiresAt).toBe(3_600_000);
    expect(isFresh(t, 3_600_000 - REFRESH_SKEW_MS - 1)).toBe(true);
    expect(isFresh(t, 3_600_000 - REFRESH_SKEW_MS)).toBe(false);
  });
});

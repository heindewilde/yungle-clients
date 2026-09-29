import { YungleClient } from 'yungle-client';
import { getAccessToken } from './auth';
import { API_BASE } from './config';

/**
 * The SDK, authenticated with the OAuth token instead of an API key.
 *
 * Done through the SDK's injectable `fetch` rather than a new option: the
 * wrapper sets the current token on every request and, on a 401, refreshes
 * once and retries — the token may have been rotated by another context a
 * moment ago. A second 401 is a real sign-out and surfaces as one.
 */
async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const res = await send(await getAccessToken());
  if (res.status !== 401) return res;
  return send(await getAccessToken({ forceRefresh: true }));
}

let client: YungleClient | null = null;

export function api(): YungleClient {
  // `apiKey` is required by the constructor and replaced on every request above.
  client ??= new YungleClient({ apiKey: 'oauth', baseUrl: API_BASE, fetch: authedFetch });
  return client;
}

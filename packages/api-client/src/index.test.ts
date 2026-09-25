import assert from 'node:assert/strict';
import { test } from 'node:test';
import { YungleApiError, YungleClient } from './index';

/**
 * The published contract of `yungle-client`.
 *
 * This package had a `test` script globbing `src/*.test.ts` with no such file
 * in it. Node's runner prints `# tests 0` and exits 0 for an unmatched glob, so
 * `pnpm -r test` — and CI's unit-test step with it — reported green for a
 * package nothing had ever checked. That is worse than having no script: it
 * looks like coverage.
 *
 * What is worth pinning is only what a CONSUMER can depend on, because this is
 * the one package in the repo that ships to npm and is imported by code we
 * will never see. Breaking any of it is a semver event.
 *
 * `fetch` is injectable, so none of this touches the network.
 */

/** A fetch stub that records what it was called with and replies as told. */
function stubFetch(reply: { status?: number; body?: unknown; json?: boolean } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  /** The nth call, asserting it happened — so "never called" fails as itself. */
  const call = (n = 0) => {
    const c = calls[n];
    assert.ok(c, `expected at least ${n + 1} fetch call(s), got ${calls.length}`);
    return c;
  };
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const status = reply.status ?? 200;
    const payload = reply.json === false ? 'not json at all' : JSON.stringify(reply.body ?? {});
    return new Response(payload, {
      status,
      headers: { 'content-type': reply.json === false ? 'text/html' : 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls, call };
}

test('an API key is required, and the failure is immediate rather than on first call', () => {
  assert.throws(() => new YungleClient({ apiKey: '' }), /API key is required/);
});

test('the base URL loses any trailing slashes, so paths never double up', async () => {
  const { fn, call } = stubFetch();
  await new YungleClient({ apiKey: 'k', baseUrl: 'http://localhost:3000/api/v1///', fetch: fn }).me();
  assert.equal(call().url, 'http://localhost:3000/api/v1/me');
});

test('the key travels as a bearer token', async () => {
  const { fn, call } = stubFetch();
  await new YungleClient({ apiKey: 'secret-key', baseUrl: 'http://x/v1', fetch: fn }).me();
  const headers = new Headers(call().init.headers);
  assert.equal(headers.get('authorization'), 'Bearer secret-key');
});

test('an error body becomes a YungleApiError carrying the machine-readable code', async () => {
  const { fn } = stubFetch({
    status: 402,
    body: { error: { code: 'plan_required', message: 'Collections need a plan.' } },
  });
  const client = new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn, maxRetries: 0 });

  const err = await client.me().then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof YungleApiError);
  assert.equal(err.status, 402);
  assert.equal(err.code, 'plan_required');
  assert.equal(err.message, 'Collections need a plan.');
});

test('a non-JSON error body still surfaces as a YungleApiError', async () => {
  // A proxy, a load balancer or an outage page answered instead of the app.
  // Consumers branch on `code`, so there has to be one even here.
  const { fn } = stubFetch({ status: 502, json: false });
  const client = new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn, maxRetries: 0 });

  const err = (await client.me().catch((e: unknown) => e)) as YungleApiError;
  assert.ok(err instanceof YungleApiError);
  assert.equal(err.code, 'http_error');
  assert.match(err.message, /502/);
});

test('retryable is true only for throttles and our own faults', () => {
  const at = (status: number) => new YungleApiError(status, 'c', 'm').retryable;
  assert.equal(at(429), true, 'throttled');
  assert.equal(at(500), true, 'our fault');
  assert.equal(at(503), true, 'our fault');
  // A 4xx will fail identically however many times it is sent. Retrying a 402
  // would also mean re-sending a request the caller was told to change.
  for (const status of [400, 401, 402, 403, 404, 409, 422]) {
    assert.equal(at(status), false, `${status} must not be retried`);
  }
});

test('retryAfterSeconds is read only when the server actually stated a number', () => {
  const withDetails = (details?: Record<string, unknown>) =>
    new YungleApiError(429, 'rate_limited', 'slow down', details).retryAfterSeconds;

  assert.equal(withDetails({ retryAfterSeconds: 30 }), 30);
  assert.equal(withDetails(), null, 'no details at all');
  assert.equal(withDetails({}), null, 'details without the field');
  assert.equal(withDetails({ retryAfterSeconds: '30' }), null, 'a string is not a number');
});

test('path segments are encoded, so an id cannot escape its position in the URL', async () => {
  const { fn, call } = stubFetch({ body: { transfer: {} } });
  const client = new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn });

  await client.getTransfer('../../me').catch(() => {});
  const { url } = call();
  assert.ok(!url.includes('../'), `a traversal survived into the URL: ${url}`);
});

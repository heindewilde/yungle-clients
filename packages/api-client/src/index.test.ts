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

/** A fetch that answers from a queue of replies, one per call. */
function sequence(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

test('a POST carries one Idempotency-Key, reused on its retry, so a 5xx is retried safely', async () => {
  const { fn, calls } = sequence([
    { status: 503, body: { error: { code: 'internal_error', message: 'x' } } },
    { status: 201, body: { contact: { id: 'c1' } } },
  ]);
  const client = new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn });
  // Backoff is real time; one short retry keeps this test quick.
  await client.createContact({ email: 'a@example.com' });
  assert.equal(calls.length, 2, 'the POST was retried');
  const keys = calls.map((c) => new Headers(c.init.headers).get('idempotency-key'));
  assert.ok(keys[0] && /^[0-9a-f-]{36}$/.test(keys[0]), 'a UUID key was sent');
  assert.equal(keys[1], keys[0], 'the retry reused it');
});

test('two separate POSTs get different keys', async () => {
  const { fn, calls } = sequence([{ status: 201, body: { contact: { id: 'c1' } } }]);
  const client = new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn });
  await client.createContact({ email: 'a@example.com' });
  await client.createContact({ email: 'b@example.com' });
  const [a, b] = calls.map((c) => new Headers(c.init.headers).get('idempotency-key'));
  assert.notEqual(a, b);
});

test('a GET carries no Idempotency-Key', async () => {
  const { fn, call } = stubFetch({ body: { transfers: [], nextCursor: null } });
  await new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn }).listTransfers();
  assert.equal(new Headers(call().init.headers).get('idempotency-key'), null);
});

test('page options become query parameters, and none means none', async () => {
  const { fn, calls } = sequence([{ status: 200, body: { transfers: [], files: [], nextCursor: null } }]);
  const client = new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn });
  await client.listTransfers();
  await client.listTransfers({ limit: 50, cursor: 'v1.abc' });
  await client.listCollectionFiles('col', 'root', { limit: 10 });
  assert.equal(calls[0]!.url, 'http://x/v1/transfers');
  assert.equal(calls[1]!.url, 'http://x/v1/transfers?limit=50&cursor=v1.abc');
  assert.equal(calls[2]!.url, 'http://x/v1/collections/col/files?folderId=root&limit=10');
});

test('allTransfers walks every page and stops at a null cursor', async () => {
  const { fn, calls } = sequence([
    { status: 200, body: { transfers: [{ id: 'a' }, { id: 'b' }], nextCursor: 'v1.b' } },
    { status: 200, body: { transfers: [{ id: 'c' }], nextCursor: null } },
  ]);
  const ids: string[] = [];
  for await (const t of new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn }).allTransfers(2)) ids.push(t.id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.url, /cursor=v1\.b/);
});

test('an older server that sends no nextCursor ends the walk after one page', async () => {
  const { fn, calls } = sequence([{ status: 200, body: { transfers: [{ id: 'a' }] } }]);
  const ids: string[] = [];
  for await (const t of new YungleClient({ apiKey: 'k', baseUrl: 'http://x/v1', fetch: fn }).allTransfers()) ids.push(t.id);
  assert.deepEqual(ids, ['a']);
  assert.equal(calls.length, 1);
});

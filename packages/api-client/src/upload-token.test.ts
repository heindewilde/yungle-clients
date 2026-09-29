import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTokenKeeper,
  MIN_RENEW_DELAY_MS,
  renewDelayMs,
  RETRY_DELAY_MS,
  tokenExpiry,
  type RenewOutcome,
} from './upload-token';

const HOUR = 3_600_000;
const tok = (exp: number, tag = 'a') =>
  `${Buffer.from(JSON.stringify({ scope: 'upload', sub: 'f1', exp, tag })).toString('base64url')}.sig`;

/** A hand-cranked clock and timer queue. */
function harness(start: number, renew: (t: string) => Promise<RenewOutcome>) {
  let t = start;
  const timers: { at: number; fn: () => void }[] = [];
  const calls: string[] = [];
  const keeper = (initial: string) =>
    createTokenKeeper(initial, {
      renew: (c) => {
        calls.push(c);
        return renew(c);
      },
      now: () => t,
      setTimer: (fn, ms) => {
        const h = { at: t + ms, fn };
        timers.push(h);
        return h;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as never);
        if (i >= 0) timers.splice(i, 1);
      },
    });
  /** Advance to the next timer and let its promise chain settle. */
  const tick = async () => {
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    if (!next) return false;
    t = next.at;
    next.fn();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return true;
  };
  return { keeper, tick, calls, now: () => t, pending: () => timers.length };
}

test('tokenExpiry reads exp from a signed token, and nothing from garbage', () => {
  assert.equal(tokenExpiry(tok(12345)), 12345);
  assert.equal(tokenExpiry('nope'), null);
  assert.equal(tokenExpiry('!!!.sig'), null);
});

test('renew at half the remaining life, never sooner than a minute', () => {
  assert.equal(renewDelayMs(2 * HOUR, 0), HOUR);
  assert.equal(renewDelayMs(30_000, 0), MIN_RENEW_DELAY_MS);
});

test('an upload that runs for six hours keeps a valid token the whole way', async () => {
  const start = 1_000_000;
  const h = harness(start, async () => ({ token: tok(h.now() + 2 * HOUR, `r${h.calls.length}`), expiresAt: h.now() + 2 * HOUR }));
  const k = h.keeper(tok(start + 2 * HOUR));
  while (h.now() < start + 6 * HOUR) {
    await h.tick();
    // The property that matters: at every moment, the current token is unexpired.
    assert.ok(tokenExpiry(k.current())! > h.now(), `token expired at +${(h.now() - start) / HOUR}h`);
  }
  assert.ok(h.calls.length >= 5, 'renewed repeatedly');
  k.stop();
  assert.equal(h.pending(), 0, 'stop() cancels the next renewal');
});

test('offline: retries every minute, and gives up once the token is dead', async () => {
  const start = 0;
  const h = harness(start, async () => 'retry');
  h.keeper(tok(start + 2 * HOUR));
  await h.tick(); // first attempt at +1h
  assert.equal(h.now(), HOUR);
  while (await h.tick()) {
    /* retries until expiry */
  }
  assert.ok(h.now() >= 2 * HOUR && h.now() <= 2 * HOUR + RETRY_DELAY_MS);
  assert.equal(h.calls.length, 1 + HOUR / RETRY_DELAY_MS);
});

test('a network error counts as retry, not as final', async () => {
  const h = harness(0, async () => {
    throw new Error('Failed to fetch');
  });
  h.keeper(tok(2 * HOUR));
  await h.tick();
  assert.equal(h.pending(), 1);
});

test('final (upload finished, or token refused) stops renewing', async () => {
  const h = harness(0, async () => 'final');
  const k = h.keeper(tok(2 * HOUR, 'orig'));
  await h.tick();
  assert.equal(h.pending(), 0);
  assert.equal(k.current(), tok(2 * HOUR, 'orig'), 'keeps the last token; the upload decides what to do');
});

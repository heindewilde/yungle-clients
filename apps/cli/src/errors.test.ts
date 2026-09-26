import assert from 'node:assert/strict';
import { test } from 'node:test';
import { YungleApiError } from 'yungle-client';
import { distance, explain, NotSignedIn, suggest } from './errors';
import { COMMANDS } from './help';

test('a typo gets the command that was meant, and nonsense gets nothing', () => {
  assert.equal(suggest('sned', COMMANDS), 'send');
  assert.equal(suggest('transfer', COMMANDS), 'transfers');
  assert.equal(suggest('stauts', COMMANDS), 'status');
  assert.equal(suggest('logn', COMMANDS), 'login');
  assert.equal(suggest('xyzzy', COMMANDS), null);
  assert.equal(distance('ab', 'ba'), 1);
});

test('every failure names what to do next', () => {
  assert.equal(explain(new NotSignedIn()).hint, 'yungle login');
  assert.equal(explain(new YungleApiError(401, 'unauthorized', 'x')).hint, 'yungle login');
  assert.match(explain(new YungleApiError(402, 'upgrade_required', 'Collections need a plan')).hint!, /open plan/);
  assert.match(explain(new YungleApiError(403, 'insufficient_scope', 'x', { required: 'transfers:send' })).hint!, /emailing/);
  assert.match(explain(new YungleApiError(429, 'rate_limited', 'x', { retryAfterSeconds: 30 })).message, /30s/);
});

test('a network failure is said in words, not as an errno', () => {
  const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.match(explain(err).message, /Could not reach Yungle/);
});

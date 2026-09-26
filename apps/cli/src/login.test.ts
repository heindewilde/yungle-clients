import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextPoll } from './login';

test('polling follows RFC 8628: wait while pending, back off on slow_down, stop on a no', () => {
  assert.deepEqual(nextPoll({ error: 'authorization_pending' }, 5), { wait: 5 });
  assert.deepEqual(nextPoll({ error: 'slow_down' }, 5), { wait: 10 });
  assert.ok('fail' in nextPoll({ error: 'access_denied' }, 5));
  assert.ok('fail' in nextPoll({ error: 'expired_token' }, 5));
  assert.ok('fail' in nextPoll({}, 5));
  assert.deepEqual(nextPoll({ access_token: 'yo_at_x' }, 5), { done: true });
});

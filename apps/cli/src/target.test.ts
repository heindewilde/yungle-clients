import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packTarget, unpackTarget } from './target';

test('a target survives the shell: base64url, one argument, round-trips', () => {
  const t = { e: 'https://yungle.co/files', i: '01J', t: 'tok.sig', n: 'Final cut.mov', s: 123 };
  const blob = packTarget(t);
  assert.match(blob, /^[A-Za-z0-9_-]+$/, 'nothing a shell would interpret');
  assert.deepEqual(unpackTarget(blob), t);
});

test('anything else is refused with a reason', () => {
  assert.throws(() => unpackTarget('!!!'), /does not decode|incomplete/);
  assert.throws(() => unpackTarget(packTarget({ e: 'file:///etc', i: 'x', t: 'x', n: 'x', s: 1 })), /incomplete/);
});

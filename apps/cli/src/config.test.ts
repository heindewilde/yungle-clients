import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionKey } from './config';

const file = (path: string, size = 10, mtimeMs = 1_700_000_000_000) => ({ path, size, mtimeMs });

test('the same files and target give the same key', () => {
  const files = [file('/a/one.cr3'), file('/a/two.cr3')];
  assert.equal(sessionKey(files, 'transfer'), sessionKey([...files], 'transfer'));
});

test('order does not matter', () => {
  // `yungle send b.jpg a.jpg` is the same upload as `yungle send a.jpg b.jpg`,
  // and a shell glob's order is not something a user chose.
  const a = file('/a/one.cr3');
  const b = file('/a/two.cr3');
  assert.equal(sessionKey([a, b], 'transfer'), sessionKey([b, a], 'transfer'));
});

test('a different target is a different session', () => {
  const files = [file('/a/one.cr3')];
  assert.notEqual(sessionKey(files, 'transfer'), sessionKey(files, 'collection:X:'));
  assert.notEqual(sessionKey(files, 'collection:X:'), sessionKey(files, 'collection:Y:'));
});

test('a changed size starts over', () => {
  // Resuming into a row whose declared size no longer matches means the server
  // rejects the finished upload, and the error points nowhere useful.
  assert.notEqual(sessionKey([file('/a/one.cr3', 10)], 't'), sessionKey([file('/a/one.cr3', 11)], 't'));
});

test('a changed mtime starts over', () => {
  const before = sessionKey([file('/a/one.cr3', 10, 1000)], 't');
  const after = sessionKey([file('/a/one.cr3', 10, 2000)], 't');
  assert.notEqual(before, after);
});

test('adding a file starts over', () => {
  const one = sessionKey([file('/a/one.cr3')], 't');
  const two = sessionKey([file('/a/one.cr3'), file('/a/two.cr3')], 't');
  assert.notEqual(one, two);
});

test('a different path starts over even with identical size and mtime', () => {
  assert.notEqual(sessionKey([file('/a/x.cr3')], 't'), sessionKey([file('/b/x.cr3')], 't'));
});

test('the key is a short, filesystem-safe hex string', () => {
  const key = sessionKey([file('/a/one.cr3')], 'transfer');
  assert.match(key, /^[0-9a-f]{32}$/);
});

test('separators cannot be forged by a crafted path', () => {
  // The parts are joined with `|` and `:`. A path containing them must not be
  // able to collide with a different file list — which is what the digest
  // buys, but it is worth pinning that the two really do differ.
  const crafted = sessionKey([file('/a:10:1700000000000|/b')], 't');
  const genuine = sessionKey([file('/a'), file('/b')], 't');
  assert.notEqual(crafted, genuine);
});

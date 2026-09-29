import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeNames, dedupePaths, parseTransferLink, resumeFrom, safeFileName, safeRelativeDir } from './get';

const ORIGIN = 'https://yungle.co';

test('a full link keeps its own origin, recipient and whether it carries a key', () => {
  assert.deepEqual(parseTransferLink('https://yungle.co/t/AbC123xyz_-9?r=01J8Z3', ORIGIN), {
    origin: 'https://yungle.co',
    kind: 't',
    slug: 'AbC123xyz_-9',
    recipient: '01J8Z3',
    hasKey: false,
  });
  const local = parseTransferLink('http://localhost:3001/t/AbC123xyz_-9#k1.secret', ORIGIN);
  assert.equal(local.origin, 'http://localhost:3001');
  assert.equal(local.hasKey, true);
});

test('a bare slug resolves against the default origin', () => {
  assert.equal(parseTransferLink('AbC123xyz_-9', ORIGIN).origin, ORIGIN);
});

test('a collection link is a collection, and never carries a recipient', () => {
  assert.deepEqual(parseTransferLink('https://yungle.co/c/nRYOMLMKf9NPgN1A0iq7bQ?r=x', ORIGIN), {
    origin: 'https://yungle.co',
    kind: 'c',
    slug: 'nRYOMLMKf9NPgN1A0iq7bQ',
    recipient: null,
    hasKey: false,
  });
});

test('anything else is refused', () => {
  for (const bad of ['https://yungle.co/pricing', 'not a link', 'https://yungle.co/t/../../etc', 'short', 'https://yungle.co/r/abcdefghij']) {
    assert.throws(() => parseTransferLink(bad, ORIGIN), /Not a Yungle link/, bad);
  }
});

test('a server-supplied folder path cannot climb out of the output directory', () => {
  assert.equal(safeRelativeDir('Ceremony/Raw'), 'Ceremony/Raw');
  assert.equal(safeRelativeDir('/Selects/Day 1/'), 'Selects/Day 1');
  assert.equal(safeRelativeDir('../../.ssh'), '.ssh');
  assert.equal(safeRelativeDir('a\\..\\b'), 'a/b');
  assert.equal(safeRelativeDir(undefined), '');
  assert.equal(safeRelativeDir('..'), '');
});

test('the same name in two folders is fine; in one folder it is numbered', () => {
  assert.deepEqual(
    dedupePaths([
      { dir: 'a', name: 'x.jpg' },
      { dir: 'b', name: 'x.jpg' },
      { dir: 'a', name: 'X.jpg' },
      { dir: '', name: 'x.jpg' },
    ]),
    ['a/x.jpg', 'b/x.jpg', 'a/X (2).jpg', 'x.jpg'],
  );
});

test('a sender-supplied name can never choose where bytes land', () => {
  assert.equal(safeFileName('../../.ssh/authorized_keys'), 'authorized_keys');
  assert.equal(safeFileName('/etc/passwd'), 'passwd');
  assert.equal(safeFileName('..\\..\\windows\\system.ini'), 'system.ini');
  assert.equal(safeFileName('..'), '_');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('a\u0000b<c>.txt'), 'a_b_c_.txt');
  assert.equal(safeFileName('Final cut (v2).mov'), 'Final cut (v2).mov');
});

test('two files with one name get distinct paths, case-insensitively', () => {
  assert.deepEqual(dedupeNames(['a.txt', 'A.txt', 'a.txt', 'b']), ['a.txt', 'A (2).txt', 'a (3).txt', 'b']);
});

test('resume only from a partial that is genuinely partial', () => {
  assert.equal(resumeFrom(0, 100), null);
  assert.equal(resumeFrom(40, 100), 40);
  assert.equal(resumeFrom(100, 100), null, 'a full .part is re-fetched, not appended to');
  assert.equal(resumeFrom(150, 100), null, 'a .part larger than the file is stale');
});

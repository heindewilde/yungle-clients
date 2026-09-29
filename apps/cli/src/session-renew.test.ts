import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Paths are resolved at import, so point the cache somewhere disposable first.
const cache = mkdtempSync(join(tmpdir(), 'yungle-cache-'));
process.env.XDG_CACHE_HOME = cache;
const { findSession, saveRenewedToken, saveSession, RESUME_PATH } = await import('./config');

const HOUR = 3_600_000;
const file = { path: '/tmp/big.mov', id: 'f1', name: 'big.mov', size: 10, uploadToken: 'old' };

test('a renewed token is written into the resume session', async () => {
  await saveSession('k1', { createdAt: Date.now(), kind: 'transfer', targetId: 't1', tusEndpoint: 'x', files: [{ ...file }] });
  await saveRenewedToken('k1', 'f1', 'new');
  const s = await findSession('k1');
  assert.equal(s?.files[0]?.uploadToken, 'new');
  assert.ok(s?.touchedAt && Date.now() - s.touchedAt < 5_000);
});

test('a session renewed recently stays resumable even when created long ago', async () => {
  const now = Date.now();
  mkdirSync(join(cache, 'yungle'), { recursive: true });
  writeFileSync(
    RESUME_PATH,
    JSON.stringify({
      renewed: { createdAt: now - 5 * HOUR, touchedAt: now - 10 * 60_000, kind: 'transfer', targetId: 't', tusEndpoint: 'x', files: [file] },
      stale: { createdAt: now - 5 * HOUR, kind: 'transfer', targetId: 't', tusEndpoint: 'x', files: [file] },
    }),
  );
  assert.ok(await findSession('renewed'), 'renewed 10 minutes ago: resumable');
  assert.equal(await findSession('stale'), null, 'never renewed, 5h old: dropped');
});

test('renewing a file the session does not know is a no-op', async () => {
  await saveSession('k2', { createdAt: Date.now(), kind: 'transfer', targetId: 't2', tusEndpoint: 'x', files: [{ ...file }] });
  const before = readFileSync(RESUME_PATH, 'utf8');
  await saveRenewedToken('k2', 'nope', 'new');
  await saveRenewedToken('missing', 'f1', 'new');
  assert.equal(readFileSync(RESUME_PATH, 'utf8'), before);
});

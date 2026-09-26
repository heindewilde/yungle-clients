import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, formatUntil, table, visible } from './ui';

test('durations read like a person would say them', () => {
  assert.equal(formatDuration(12), '12s');
  assert.equal(formatDuration(70), '1m 10s');
  assert.equal(formatDuration(3 * 3600 + 240), '3h 04m');
});

test('expiry is a distance, not a timestamp', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  assert.equal(formatUntil('2026-10-02T12:00:00Z', now), 'in 6 days');
  assert.equal(formatUntil('2026-09-26T15:00:00Z', now), 'in 3 hours');
  assert.equal(formatUntil('2026-09-20T12:00:00Z', now), 'expired');
});

test('a table never wraps: the flexible column gives way', () => {
  const cols = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
  const out = table([['01ABC', 'A very long title that would never fit in forty columns', '1.2 GB']], { flex: 1 });
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  assert.ok(out.split('\n').every((l) => visible(l) <= 40), out);
  assert.match(out, /…/);
});

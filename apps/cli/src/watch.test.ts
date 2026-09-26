import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprint, planTick } from './watch';

const file = (path: string, size: number, mtimeMs = 1) => ({ path, name: path, size, mtimeMs, relativeDir: '' });

test('a file goes up only once it has stopped changing', () => {
  const uploaded = new Set<string>();
  const first = planTick([file('a.exr', 100)], new Set(), uploaded);
  assert.deepEqual(first.ready, [], 'first sighting: wait');
  const growing = planTick([file('a.exr', 200, 2)], first.seen, uploaded);
  assert.deepEqual(growing.ready, [], 'still being written');
  const settled = planTick([file('a.exr', 200, 2)], growing.seen, uploaded);
  assert.deepEqual(settled.ready.map((f) => f.path), ['a.exr']);
});

test('what went up never goes up again', () => {
  const f = file('a.exr', 100);
  const uploaded = new Set([fingerprint(f)]);
  assert.deepEqual(planTick([f], new Set([fingerprint(f)]), uploaded).ready, []);
});

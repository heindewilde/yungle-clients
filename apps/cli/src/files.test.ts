import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectFiles, formatBytes, pairWithTargets, toFileInputs } from './files';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yungle-cli-'));
  const shoot = join(root, 'Shoot');
  await mkdir(join(shoot, 'Ceremony', 'Raw'), { recursive: true });
  await mkdir(join(shoot, 'Portraits'), { recursive: true });
  await writeFile(join(shoot, 'Ceremony', 'Raw', 'IMG_0001.cr3'), 'a');
  // Same filename, different folder — the collision a photo shoot makes routine.
  await writeFile(join(shoot, 'Portraits', 'IMG_0001.cr3'), 'bb');
  await writeFile(join(shoot, '.DS_Store'), 'junk');
  await writeFile(join(shoot, 'Ceremony', '.hidden'), 'junk');
  await writeFile(join(root, 'loose.txt'), 'ccc');
  return root;
}

test('a directory keeps its own name at the top of the tree', async () => {
  const root = await fixture();
  const files = await collectFiles([join(root, 'Shoot')]);
  const paths = files.map((f) => `${f.relativeDir}/${f.name}`).sort();
  assert.deepEqual(paths, [
    'Shoot/Ceremony/Raw/IMG_0001.cr3',
    'Shoot/Portraits/IMG_0001.cr3',
  ]);
});

test('hidden files inside a walked directory are skipped', async () => {
  // A dropped shoot folder carries .DS_Store in every subdirectory, and each
  // one would otherwise become a quota-counted file in the client's gallery.
  const root = await fixture();
  const files = await collectFiles([join(root, 'Shoot')]);
  assert.ok(!files.some((f) => f.name.startsWith('.')), files.map((f) => f.name).join(','));
});

test('a hidden file named directly is still sent', async () => {
  const root = await fixture();
  const files = await collectFiles([join(root, 'Shoot', '.DS_Store')]);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.relativeDir, '', 'a directly-named file has no folder');
});

test('a loose file carries no folder', async () => {
  const root = await fixture();
  const files = await collectFiles([join(root, 'loose.txt')]);
  assert.deepEqual(toFileInputs(files), [{ name: 'loose.txt', size: 3 }]);
});

test('sizes and mtimes are read from disk', async () => {
  const root = await fixture();
  const files = await collectFiles([join(root, 'Shoot')]);
  for (const f of files) {
    assert.ok(f.size > 0, f.name);
    assert.ok(f.mtimeMs > 0, `${f.name} needs an mtime for the resume key`);
  }
});

test('toFileInputs omits an empty path rather than sending ""', async () => {
  const root = await fixture();
  const [loose] = await collectFiles([join(root, 'loose.txt')]);
  assert.ok(!('path' in toFileInputs([loose!])[0]!));
});

test('targets are paired by position, never by name', () => {
  // Two files share a name and differ in size; a name-keyed match would resolve
  // both to one server row, so one upload overwrites the other and one row is
  // orphaned. The browser uploader shipped exactly that bug.
  const files = [
    { path: '/a/IMG.cr3', name: 'IMG.cr3', size: 1, relativeDir: 'a', mtimeMs: 1 },
    { path: '/b/IMG.cr3', name: 'IMG.cr3', size: 2, relativeDir: 'b', mtimeMs: 1 },
  ];
  const targets = [{ id: 'first' }, { id: 'second' }];
  const paired = pairWithTargets(files, targets);
  assert.equal(paired[0]!.target.id, 'first');
  assert.equal(paired[0]!.file.path, '/a/IMG.cr3');
  assert.equal(paired[1]!.target.id, 'second');
  assert.equal(paired[1]!.file.path, '/b/IMG.cr3');
});

test('a length mismatch refuses rather than guessing', () => {
  const files = [{ path: '/a', name: 'a', size: 1, relativeDir: '', mtimeMs: 1 }];
  assert.throws(() => pairWithTargets(files, [{ id: '1' }, { id: '2' }]), /Refusing to guess/);
});

test('byte formatting stays readable at every scale', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 * 20), '20 MB');
  assert.equal(formatBytes(1024 ** 4 * 3), '3.0 TB');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagsByCommand } from './completion';
import { ALIASES, COMMANDS, commandHelp, HELP, resolveAlias } from './help';

test('every command in the help is known to completion and "did you mean", and back', () => {
  const inHelp = new Set([...HELP.matchAll(/^ {2}yungle ([a-z]+)/gm)].map((m) => m[1]!));
  const known = new Set(COMMANDS.filter((c) => c !== 'help'));
  assert.deepEqual([...inHelp].sort(), [...known].sort());
});

test('old spellings keep working', () => {
  assert.deepEqual(resolveAlias(['ls', 'transfers', '--json']), ['transfers', '--json']);
  assert.deepEqual(resolveAlias(['auth', 'login']), ['login', '--key']);
  assert.deepEqual(resolveAlias(['rm', 'transfer', '01X']), ['revoke', '01X']);
  assert.deepEqual(resolveAlias(['send', 'x']), ['send', 'x']);
  for (const [, to] of Object.entries(ALIASES)) assert.ok((COMMANDS as readonly string[]).includes(to[0]!), to[0]);
});

test('per-command help carries its flags and examples', () => {
  const send = commandHelp('send')!;
  assert.match(send, /--to <email>/);
  assert.match(send, /Examples/);
  assert.equal(commandHelp('nonsense'), null);
});

test('completion knows each command’s flags', () => {
  const f = flagsByCommand();
  assert.ok(f.send!.includes('--to'));
  assert.ok(f.watch!.includes('--existing'));
});

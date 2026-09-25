import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listFlag, numberFlag, parseArgs, stringFlag } from './args';

test('a bare command parses', () => {
  const { command, positionals, flags } = parseArgs(['ls']);
  assert.equal(command, 'ls');
  assert.deepEqual(positionals, []);
  assert.deepEqual(flags, {});
});

test('positionals and flags interleave freely', () => {
  const { command, positionals, flags } = parseArgs(['send', 'a.jpg', '--json', 'b.jpg']);
  assert.equal(command, 'send');
  assert.deepEqual(positionals, ['a.jpg', 'b.jpg']);
  assert.equal(flags.json, true);
});

test('value flags take the next token', () => {
  const { flags } = parseArgs(['send', 'a.jpg', '--to', 'anna@example.com']);
  assert.equal(flags.to, 'anna@example.com');
});

test('--flag=value works too', () => {
  const { flags } = parseArgs(['send', '--title=Rushes — Tuesday']);
  assert.equal(flags.title, 'Rushes — Tuesday');
});

test('a value flag followed by another flag is an error, not a silent swallow', () => {
  // The bug this prevents: a parser that takes "the next token" unconditionally
  // reads `--json` as the value of `--to`, then reports a missing recipient for
  // a command line that was perfectly correct.
  assert.throws(() => parseArgs(['send', 'a.jpg', '--to', '--json']), /--to needs a value/);
});

test('a boolean flag does not eat the following positional', () => {
  const { positionals, flags } = parseArgs(['send', '--json', 'a.jpg']);
  assert.equal(flags.json, true);
  assert.deepEqual(positionals, ['a.jpg']);
});

test('-- ends flag parsing so oddly-named files can be sent', () => {
  const { positionals, flags } = parseArgs(['send', '--json', '--', '--weird.jpg', '--to']);
  assert.equal(flags.json, true);
  assert.deepEqual(positionals, ['--weird.jpg', '--to']);
});

test('no arguments at all asks for help rather than crashing', () => {
  assert.equal(parseArgs([]).command, 'help');
});

test('listFlag splits on commas and trims', () => {
  assert.deepEqual(listFlag('a@x.com, b@x.com ,c@x.com'), ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('listFlag of an absent or boolean flag is empty, never [true]', () => {
  assert.deepEqual(listFlag(undefined), []);
  assert.deepEqual(listFlag(true), []);
  assert.deepEqual(listFlag(''), []);
});

test('numberFlag accepts positive integers only', () => {
  assert.equal(numberFlag('90', 'expires'), 90);
  assert.equal(numberFlag(undefined, 'expires'), undefined);
  for (const bad of ['0', '-1', '1.5', 'ninety', '']) {
    assert.throws(() => numberFlag(bad, 'expires'), /positive whole number/, bad);
  }
});

test('stringFlag ignores a boolean', () => {
  // `--title` with no value parses as `true`; passing that through would send
  // the literal string "true" as the transfer's title.
  assert.equal(stringFlag(true), undefined);
  assert.equal(stringFlag('Rushes'), 'Rushes');
});

/**
 * Every flag the help text documents as taking a value must be in VALUE_FLAGS.
 *
 * This exists because `yungle mcp install --client cursor` silently installed
 * into EVERY client. `client` was missing from VALUE_FLAGS, so it parsed as a
 * boolean and `cursor` became a stray positional — the command line was exactly
 * what the help promised, and the parser quietly disagreed.
 *
 * The failure is invisible in both directions: the flag "works" (no error), and
 * a unit test written against `--client=cursor` passes while the documented
 * space-separated form does not. Deriving the expectation from HELP is the only
 * version that catches the next one.
 */
test('every value-taking flag in HELP is parsed as one', async () => {
  const { HELP } = await import('./index');
  // Lines shaped like `    --client <id>   …` or `--to <email>`.
  const documented = [...HELP.matchAll(/--([a-z-]+)\s+</g)].map((m) => m[1]!);
  assert.ok(documented.length >= 8, `found only ${documented.length} value flags in HELP`);

  for (const flag of new Set(documented)) {
    const { flags, positionals } = parseArgs(['x', `--${flag}`, 'VALUE']);
    assert.equal(
      flags[flag],
      'VALUE',
      `--${flag} is documented as taking a value but parsed as ${JSON.stringify(flags[flag])}`,
    );
    assert.deepEqual(positionals, [], `--${flag} left "VALUE" as a positional`);
  }
});

test('a boolean flag does not swallow the next token', async () => {
  const { HELP } = await import('./index');
  // The other direction: anything documented WITHOUT a value placeholder must
  // stay boolean, or `--json send` would eat the verb.
  const booleans = [...HELP.matchAll(/--([a-z-]+)(?:\s{2,}|\n)/g)]
    .map((m) => m[1]!)
    .filter((f) => !new RegExp(`--${f}\\s+<`).test(HELP));
  for (const flag of new Set(booleans)) {
    const { flags, positionals } = parseArgs(['x', `--${flag}`, 'KEEP']);
    assert.equal(flags[flag], true, `--${flag} should be boolean`);
    assert.deepEqual(positionals, ['KEEP'], `--${flag} swallowed the next token`);
  }
});

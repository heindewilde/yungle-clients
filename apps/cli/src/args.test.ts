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

/**
 * A small argument parser.
 *
 * Deliberately hand-rolled rather than pulling in commander or yargs. The whole
 * surface is a verb, some paths and a handful of flags; a dependency here would
 * be most of the CLI's install weight and all of its supply-chain exposure, for
 * a hundred lines of behaviour. Pure, so the parsing rules are testable without
 * spawning a process.
 */

export interface ParsedArgs {
  command: string;
  /** Everything that is not a flag or the command itself. */
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that take a value. Everything else is a boolean.
 *
 * An explicit list, because `--json --to a@b.com` is ambiguous otherwise: a
 * parser that assumes the next token is a value would swallow `--to` as the
 * value of `--json` and then complain about a missing recipient, which is a
 * baffling error for a correct command line.
 */
const VALUE_FLAGS = new Set([
  'to',
  'message',
  'title',
  'password',
  'expires',
  'collection',
  'transfer',
  'folder',
  'out',
  'url',
  'key',
  // `yungle mcp install --client cursor` silently installed into EVERY client
  // before this was added: the flag parsed as a boolean, `cursor` became a stray
  // positional, and the filter was never applied. The help text promised
  // `--client <id>`, so the command line was correct and the parser was not.
  // `helpFlagsAreParsed` in args.test.ts now derives this from HELP.
  'client',
  'forward-to',
  'interval',
  'from-url',
  'target',
]);

/**
 * Flags that may be given more than once, every value kept. `--to a --to b`
 * used to keep only `b` — the help promised "repeatable" and the parser
 * silently dropped every recipient but the last.
 */
const REPEATABLE = new Set(['to', 'from-url']);

/** Value flags that may also stand alone, meaning "prompt for it". */
const OPTIONAL_VALUE = new Set(['key']);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;

    // `--` ends flag parsing, so a file genuinely called `--weird.jpg` can be
    // sent by putting it after one.
    if (token === '--') {
      positionals.push(...rest.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        const name = body.slice(0, eq);
        const prior = flags[name];
        flags[name] = REPEATABLE.has(name) && typeof prior === 'string' ? `${prior}\n${body.slice(eq + 1)}` : body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith('--')) {
          // `yungle login --key` on its own means "ask me for it".
          if (OPTIONAL_VALUE.has(body)) {
            flags[body] = true;
            continue;
          }
          throw new Error(`--${body} needs a value.`);
        }
        const prior = flags[body];
        flags[body] = REPEATABLE.has(body) && typeof prior === 'string' ? `${prior}\n${value}` : value;
        i++;
        continue;
      }
      flags[body] = true;
      continue;
    }

    positionals.push(token);
  }

  return { command, positionals, flags };
}

/** Read a repeatable flag as a list: `--to a@b.com --to c@d.com`, or comma-separated. */
export function listFlag(value: string | boolean | undefined): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A repeatable URL flag. Split only between repetitions, never on commas: a
 * presigned URL's query string may contain one.
 */
export function urlListFlag(value: string | boolean | undefined): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function numberFlag(value: string | boolean | undefined, name: string): number | undefined {
  if (value === undefined || typeof value === 'boolean') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number.`);
  return n;
}

export function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

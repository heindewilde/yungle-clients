import { explain } from './errors';
import { accentErr, e, isTTY, sym } from './ui';

/**
 * Where results go. `--json`: one JSON document on stdout. A terminal: the
 * pretty version. A pipe: the plain version — usually just the link — so
 * `yungle send x | pbcopy` copies the link rather than a paragraph.
 */
export function out(json: boolean, data: unknown, pretty: string, plain: string = pretty, code = 0): number {
  // At a terminal every result starts after a blank line, like the progress
  // headings do, so a command's output is separate from the prompt above it.
  const human = isTTY ? `${pretty.startsWith('\n') ? '' : '\n'}${pretty}\n` : `${plain}\n`;
  process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : human);
  return code;
}

/** Print an error the way a person needs it: what happened, then what to run. */
export function fail(err: unknown, json: boolean): number {
  const x = explain(err);
  if (json) {
    process.stdout.write(`${JSON.stringify({ error: { code: x.code, message: x.message, ...(x.details ? { details: x.details } : {}) } }, null, 2)}\n`);
  } else {
    process.stderr.write(`\n  ${e.red(sym.fail)} ${x.message}\n`);
    if (x.hint) process.stderr.write(`    ${e.dim(sym.arrow)} ${accentErr(x.hint)}\n`);
    process.stderr.write('\n');
  }
  return x.code === 'usage' ? 2 : 1;
}

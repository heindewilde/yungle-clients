import { formatBytes } from './files';
import pc from 'picocolors';

/**
 * How the CLI looks: calm, mostly plain, one green accent.
 *
 * Two audiences, one binary. A person at a terminal gets colour, a live
 * progress bar and tidy tables; a pipe or a CI log gets plain text with no
 * escape codes, and `--json` gets JSON. Everything decorative goes through
 * here, so nothing else has to ask which of the three it is talking to.
 *
 * Colour follows the conventions: off when the stream is not a terminal, off
 * with NO_COLOR, on with FORCE_COLOR.
 */

const env = process.env;

function colourFor(stream: NodeJS.WriteStream): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

const outColour = colourFor(process.stdout);
const errColour = colourFor(process.stderr);
export const o = pc.createColors(outColour);
export const e = pc.createColors(errColour);

/** Yungle green where the terminal can show it exactly, ANSI green otherwise. */
const trueColour = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit';
function brand(enabled: boolean, fallback: (s: string) => string) {
  return (s: string) => (!enabled ? s : trueColour ? `\x1b[38;2;52;168;104m${s}\x1b[39m` : fallback(s));
}
export const accentOut = brand(outColour, o.green);
export const accentErr = brand(errColour, e.green);

/** Plain-ASCII symbols for the old Windows console, which cannot draw these. */
const ascii = process.platform === 'win32' && !env.WT_SESSION && env.TERM_PROGRAM !== 'vscode';
export const sym = {
  ok: ascii ? '√' : '✔',
  fail: ascii ? '×' : '✖',
  warn: ascii ? '!' : '▲',
  arrow: ascii ? '->' : '→',
  dot: '·',
  full: ascii ? '#' : '█',
  empty: ascii ? '-' : '░',
};

export const isTTY = Boolean(process.stdout.isTTY);

/** May we ask questions? Only a person at a terminal, never a script or CI. */
export function interactive(flags: Record<string, string | boolean>): boolean {
  return (
    Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
    flags.json !== true &&
    flags.yes !== true &&
    !env.CI
  );
}

// ── Numbers and times ───────────────────────────────────────────────────────

export { formatBytes };

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Oct", or "3 Oct 2027" when it is not this year. */
export function formatDate(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** "in 6 days", "in 3 hours", "expired". For expiry, where the distance is what matters. */
export function formatUntil(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'no expiry';
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'expired';
  const h = ms / 3_600_000;
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `in ${Math.round(h)} hours`;
  return `in ${Math.round(h / 24)} days`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Progress ────────────────────────────────────────────────────────────────

export function bar(fraction: number, width = 20): string {
  const f = Math.min(1, Math.max(0, fraction));
  const full = Math.round(f * width);
  return accentErr(sym.full.repeat(full)) + e.dim(sym.empty.repeat(width - full));
}

/**
 * One progress line, redrawn in place: bar, percentage, bytes, speed, time left.
 * The ETA uses the average speed so far — steadier than an instantaneous rate,
 * which swings wildly on a connection that bursts.
 */
export function progressLine(done: number, total: number, startedAt: number, extra = ''): string {
  const secs = Math.max(0.5, (Date.now() - startedAt) / 1000);
  const rate = done / secs;
  const pct = total > 0 ? done / total : 1;
  const left = rate > 0 && total > done ? `${formatDuration((total - done) / rate)} left` : '';
  const parts = [`${formatBytes(done)} of ${formatBytes(total)}`, `${formatBytes(rate)}/s`, left, extra].filter(Boolean);
  return `  ${bar(pct)}  ${String(Math.floor(pct * 100)).padStart(3)}%  ${e.dim(parts.join(` ${sym.dot} `))}`;
}

let lastLine = '';

/** Redraw the progress line on stderr. Silent when stderr is not a terminal. */
export function drawProgress(line: string): void {
  if (!process.stderr.isTTY || line === lastLine) return;
  lastLine = line;
  process.stderr.write(`\r\x1b[2K${line}`);
}

export function endProgress(): void {
  if (!process.stderr.isTTY || !lastLine) return;
  process.stderr.write('\r\x1b[2K');
  lastLine = '';
}

// ── Tables ──────────────────────────────────────────────────────────────────

// Matching the escape character is the point: this strips colour codes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export const visible = (s: string) => s.replace(ANSI, '').length;

function fit(s: string, width: number): string {
  const len = visible(s);
  if (len <= width) return s + ' '.repeat(width - len);
  const plain = s.replace(ANSI, '');
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Rows in aligned columns, sized to the terminal. One column is the one that
 * gives way (usually the title): it shrinks, with an ellipsis, so the row never
 * wraps; the others keep their width.
 */
export function table(rows: string[][], opts: { flex: number; header?: string[] } = { flex: 0 }): string {
  const all = opts.header ? [opts.header.map((h) => o.dim(h)), ...rows] : rows;
  if (all.length === 0) return '';
  const cols = all[0]!.length;
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...all.map((r) => visible(r[i] ?? ''))));
  const gap = 2;
  const total = widths.reduce((a, b) => a + b, 0) + gap * (cols - 1) + 2;
  const room = process.stdout.columns ?? 120;
  if (total > room) widths[opts.flex] = Math.max(8, widths[opts.flex]! - (total - room));
  return all
    // The last column is not padded (nothing follows it), unless it is the one
    // that gives way, in which case it is cut to fit like any other.
    .map((r) => `  ${r.map((cell, i) => (i === cols - 1 && i !== opts.flex ? cell : fit(cell, widths[i]!))).join(' '.repeat(gap))}`.trimEnd())
    .join('\n');
}

// ── Messages ────────────────────────────────────────────────────────────────

/** "✔ Sent" plus indented detail lines, for stdout. */
export function success(title: string, lines: string[] = []): string {
  return [`  ${accentOut(sym.ok)} ${o.bold(title)}`, ...lines.map((l) => `    ${l}`)].join('\n');
}

/** "Next: yungle status 01J… (see who downloaded)" */
export function next(command: string, why?: string): string {
  return `  ${o.dim('Next:')} ${accentOut(command)}${why ? o.dim(`  (${why})`) : ''}`;
}

export function note(text: string): void {
  process.stderr.write(`  ${e.dim(text)}\n`);
}

export function heading(text: string): void {
  process.stderr.write(`\n  ${text}\n`);
}

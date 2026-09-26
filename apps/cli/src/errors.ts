import { YungleApiError } from 'yungle-client';

/**
 * Every failure, said the way a person needs it: what happened, and the one
 * command that gets them unstuck. Pure, so each explanation is tested.
 */

export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly code = 'cli_error',
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class NotSignedIn extends CliError {
  constructor() {
    super('You are not signed in.', 'yungle login', 'not_signed_in');
  }
}

export interface Explained {
  message: string;
  hint?: string;
  code: string;
  details?: Record<string, unknown>;
}

export function explain(err: unknown): Explained {
  if (err instanceof CliError) return { message: err.message, hint: err.hint, code: err.code };
  if (err instanceof YungleApiError) {
    const base = { code: err.code, details: err.details };
    switch (err.code) {
      case 'unauthorized':
        return { ...base, message: 'Your sign-in is no longer valid (revoked, expired or mistyped).', hint: 'yungle login' };
      case 'insufficient_scope': {
        const required = typeof err.details?.required === 'string' ? err.details.required : null;
        return {
          ...base,
          message: err.message,
          hint: required === 'transfers:send' ? 'yungle open keys   (allow emailing, or send without --to)' : 'yungle open keys   (create a key that may do this)',
        };
      }
      case 'upgrade_required':
        return { ...base, message: err.message, hint: 'yungle open plan' };
      case 'quota_exceeded':
        return { ...base, message: 'Your storage is full.', hint: 'yungle open   (free up space, or upgrade)' };
      case 'out_of_credit':
        return { ...base, message: err.message, hint: 'yungle open usage   (add credit)' };
      case 'rate_limited':
        return {
          ...base,
          message: `Too many requests.${err.retryAfterSeconds ? ` Try again in ${err.retryAfterSeconds}s.` : ' Try again shortly.'}`,
        };
      case 'not_found':
        return { ...base, message: err.message, hint: 'yungle transfers   (list what you have)' };
      case 'email_budget_exhausted':
        return { ...base, message: err.message, hint: 'Share the link yourself; the transfer is live.' };
      default:
        return { ...base, message: err.message };
    }
  }
  const e = err as NodeJS.ErrnoException & { cause?: { code?: string } };
  const netCode = e?.cause?.code ?? e?.code;
  if (netCode && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(netCode)) {
    return { code: 'network', message: 'Could not reach Yungle. Check your connection and try again.' };
  }
  if (e?.code === 'ENOENT' && typeof e.path === 'string') {
    return { code: 'not_found', message: `No such file or folder: ${e.path}` };
  }
  return { code: 'cli_error', message: e instanceof Error ? e.message : String(err) };
}

// ── "Did you mean" ──────────────────────────────────────────────────────────

export function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      // A swapped pair ("sned") is one slip, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1);
      }
    }
  }
  return dp[a.length]![b.length]!;
}

/** The closest known word, if it is close enough to be what was meant. */
export function suggest(word: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = distance(word.toLowerCase(), k);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(best.length / 3)) ? best : null;
}

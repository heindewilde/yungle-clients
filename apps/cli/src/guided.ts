import * as p from '@clack/prompts';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError } from './errors';

/**
 * The questions the CLI asks when a person leaves something out. Only ever
 * called when `interactive()` says a human is there (a TTY, no --json, no
 * --yes, not CI); a script gets a usage error instead, never a prompt it
 * cannot answer.
 */

function answered<T>(v: T | symbol): Exclude<T, symbol> {
  if (p.isCancel(v) || typeof v === 'symbol') throw new CliError('Cancelled.', undefined, 'cancelled', 130);
  return v as Exclude<T, symbol>;
}

export async function askSend(): Promise<{ paths: string[]; to: string[]; message?: string }> {
  const path = answered(
    await p.text({
      message: 'What should I send?',
      placeholder: 'a file or folder, e.g. ~/Shoot',
      validate: (v) => (v?.trim() ? undefined : 'Give a path.'),
    }),
  ).trim();
  const expanded = path.startsWith('~/') ? resolve(process.env.HOME ?? '', path.slice(2)) : resolve(path);
  await stat(expanded).catch(() => {
    throw new CliError(`No such file or folder: ${path}`, undefined, 'not_found');
  });
  const to = answered(
    await p.text({
      message: 'Email it to anyone?',
      placeholder: 'addresses, comma-separated; leave empty for a link only',
    }),
  )
    .split(/[,\s]+/)
    .filter(Boolean);
  const message = to.length
    ? answered(await p.text({ message: 'A note for them?', placeholder: 'optional' })).trim() || undefined
    : undefined;
  return { paths: [expanded], to, message };
}

export async function confirm(message: string): Promise<boolean> {
  return answered(await p.confirm({ message, initialValue: true }));
}

export async function askLink(): Promise<string> {
  return answered(
    await p.text({ message: 'Paste the link', placeholder: 'https://yungle.co/t/…', validate: (v) => (v?.includes('/t/') || /^[\w-]{8,}$/.test(v ?? '') ? undefined : 'That is not a transfer link.') }),
  ).trim();
}

export async function askPassword(): Promise<string> {
  return answered(await p.password({ message: 'This transfer has a password' })).trim();
}

export async function pick<T extends string>(message: string, options: { value: T; label: string; hint?: string }[]): Promise<T> {
  return answered(await p.select({ message, options: options as never })) as T;
}

export async function askKey(): Promise<string> {
  return answered(
    await p.password({
      message: 'Paste an API key (create one at yungle.co/dashboard/settings/api)',
      validate: (v) => (v?.startsWith('yk_live_') ? undefined : 'Keys start with yk_live_.'),
    }),
  ).trim();
}

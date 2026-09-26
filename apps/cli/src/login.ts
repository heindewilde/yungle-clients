import { spawn } from 'node:child_process';
import { CLI_CLIENT_ID, originOf, readConfig, writeConfig } from './config';

/**
 * `yungle login`: the OAuth device flow (RFC 8628). The terminal shows a code,
 * the browser approves it, the CLI polls until it has tokens. Nothing to copy,
 * and it works over SSH, because the browser can be on another machine.
 */

const SCOPES = [
  'transfers:read',
  'transfers:write',
  'collections:read',
  'collections:write',
  'contacts:read',
  'contacts:write',
  'webhooks:read',
  'webhooks:write',
];

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Not sent by Yungle (a pre-filled link is what a phishing mail sends); tolerated if present. */
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** What to do with one poll answer: pure, so the backoff rules are testable. */
export function nextPoll(
  answer: { error?: string; access_token?: string },
  interval: number,
): { done: true } | { wait: number } | { fail: string } {
  if (answer.access_token) return { done: true };
  switch (answer.error) {
    case 'authorization_pending':
      return { wait: interval };
    case 'slow_down':
      return { wait: interval + 5 }; // RFC 8628 §3.5
    case 'access_denied':
      return { fail: 'The request was declined in the browser.' };
    case 'expired_token':
      return { fail: 'The code expired. Run `yungle login` again.' };
    default:
      return { fail: `Sign-in failed: ${answer.error ?? 'unexpected answer'}.` };
  }
}

export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // No browser here (a server over SSH): the printed URL is the fallback.
  }
}

export async function deviceLogin(baseUrl: string | undefined, opts: { openBrowser: boolean }): Promise<string> {
  const origin = originOf(baseUrl);
  const start = await fetch(`${origin}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLI_CLIENT_ID, scope: SCOPES.join(' ') }),
  });
  if (!start.ok) throw new Error(`Could not start sign-in (HTTP ${start.status}).`);
  const d = (await start.json()) as DeviceStart;

  process.stderr.write(`\nOpen ${d.verification_uri}\nand type the code  ${d.user_code}\n\n`);
  if (opts.openBrowser) openBrowser(d.verification_uri);

  let interval = d.interval;
  const deadline = Date.now() + d.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: d.device_code,
        client_id: CLI_CLIENT_ID,
      }),
    });
    const answer = (await res.json()) as {
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    const step = nextPoll(answer, interval);
    if ('fail' in step) throw new Error(step.fail);
    if ('done' in step) {
      const config = await readConfig();
      await writeConfig({
        ...config,
        ...(baseUrl ? { baseUrl } : {}),
        oauth: {
          accessToken: answer.access_token!,
          refreshToken: answer.refresh_token!,
          expiresAt: Date.now() + (answer.expires_in ?? 3600) * 1000,
        },
      });
      return answer.scope ?? '';
    }
    interval = step.wait;
  }
  throw new Error('The code expired. Run `yungle login` again.');
}

/** Revoke the saved tokens (best effort) and forget them. */
export async function logout(baseUrl: string | undefined): Promise<boolean> {
  const config = await readConfig();
  if (!config.oauth) return false;
  const origin = originOf(baseUrl ?? config.baseUrl);
  for (const token of [config.oauth.refreshToken, config.oauth.accessToken]) {
    await fetch(`${origin}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => undefined);
  }
  const { oauth: _gone, ...rest } = config;
  await writeConfig(rest);
  return true;
}

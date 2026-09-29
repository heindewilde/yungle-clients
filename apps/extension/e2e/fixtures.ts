import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';

/**
 * The extension loaded into a real Chromium, pointed at a local Yungle.
 *
 * `YUNGLE_SERVER_DIR` is a checkout of the server repo whose `.env.dev` puts
 * the web app on :3002 and upload-svc on :4002 (the ports `pnpm e2e:build`
 * bakes in). Its scripts mint the credentials: a real OAuth token pair
 * (`dev:oauth-token`) and a signed-in site session (`dev:session`).
 */

export const ORIGIN = 'http://localhost:3002';
const EXTENSION = resolve(import.meta.dirname, '../.output-e2e/chrome-mv3');
const SERVER = process.env.YUNGLE_SERVER_DIR ?? resolve(import.meta.dirname, '../../../../yungle-extension');

function serverScript(args: string[]): string {
  return execFileSync('node', ['scripts/with-dev-env.mjs', 'pnpm', '-s', ...args], {
    cwd: SERVER,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function mintTokens(email: string, opts: { free?: boolean } = {}) {
  const out = serverScript(['--filter', '@yungle/web', 'dev:oauth-token', email, ...(opts.free ? ['--free'] : [])]);
  const pair = JSON.parse(out.split('\n').pop()!) as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: pair.access_token, refreshToken: pair.refresh_token, expiresAt: Date.now() + pair.expires_in * 1000 };
}

export function siteSessionCookie(email: string): { name: string; value: string } {
  const line = serverScript(['dev:session', email]);
  const [name, value] = line.replace(/^Cookie:\s*/, '').split('=') as [string, string];
  return { name, value };
}

type Fixtures = { context: BrowserContext; worker: Worker; extensionId: string };

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'yungle-ext-')), {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
});

export const expect = test.expect;

/** Put a token pair where the extension keeps it, as a finished sign-in would. */
export async function seedSignIn(worker: Worker, tokens: ReturnType<typeof mintTokens>): Promise<void> {
  // `chrome` exists in the service worker; this file is typed for Node.
  await worker.evaluate((t) => (globalThis as unknown as ChromeLike).chrome.storage.local.set({ auth: t }), tokens);
}

/** What the extension has stored, read from its service worker. */
export async function stored(worker: Worker, key: string): Promise<unknown> {
  return worker.evaluate(async (k) => (await (globalThis as unknown as ChromeLike).chrome.storage.local.get(k))[k], key);
}

type ChromeLike = {
  chrome: { storage: { local: { set(v: object): Promise<void>; get(k: string): Promise<Record<string, unknown>> } } };
}

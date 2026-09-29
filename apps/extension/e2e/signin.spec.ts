import { expect, mintTokens, ORIGIN, siteSessionCookie, stored, test } from './fixtures';

/**
 * The real consent round-trip: popup → yungle.co consent → our redirect page →
 * the background exchanges the code and closes the tab. The site is already
 * signed in (a magic link is the one step a test cannot click).
 */
test('signing in from the popup finishes on its own', async ({ context, extensionId, worker }) => {
  // `dev:session` signs in an existing account; minting a token creates it.
  mintTokens('ext-signin@yungle.test');
  const { name, value } = siteSessionCookie('ext-signin@yungle.test');
  await context.addCookies([{ name, value, domain: 'localhost', path: '/' }]);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const [consent] = await Promise.all([context.waitForEvent('page'), popup.getByRole('button', { name: 'Sign in with Yungle' }).click()]);
  await consent.waitForLoadState();
  expect(consent.url()).toContain(`${ORIGIN}/oauth/authorize`);
  await expect(consent.getByText('This is Yungle’s own browser extension')).toBeVisible();
  // Emailing people is pre-ticked for the extension (a person presses Send).
  await expect(consent.getByLabel('Email transfers to recipients on your behalf')).toBeChecked();
  await consent.getByRole('button', { name: 'Allow' }).click();

  await expect.poll(async () => Boolean(await stored(worker, 'auth')), { timeout: 15_000 }).toBe(true);
  // The redirect tab closes itself.
  await expect.poll(() => consent.isClosed(), { timeout: 5_000 }).toBe(true);
  // And the popup, which never reloaded, is signed in.
  await expect(popup.getByRole('button', { name: 'Send files' })).toBeVisible();
});

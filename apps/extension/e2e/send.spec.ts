import { expect, mintTokens, ORIGIN, seedSignIn, test } from './fixtures';

const file = (name: string, text = 'hello from the extension test\n') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

test.beforeEach(async ({ worker }) => {
  await seedSignIn(worker, mintTokens('ext-send@yungle.test'));
});

test('the side panel sends files and hands back a working link', async ({ context, extensionId }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('input[type=file]').setInputFiles([file('report.txt'), file('notes.txt', 'second file')]);
  await expect(panel.getByText('2 files')).toBeVisible();
  await panel.getByRole('button', { name: 'Get a link' }).click();

  await expect(panel.getByText('Your link is ready')).toBeVisible({ timeout: 30_000 });
  const link = await panel.getByLabel('Link').inputValue();
  expect(link).toMatch(new RegExp(`^${ORIGIN}/t/[a-z0-9]+`));
  expect(link).not.toContain('#');

  // The recipient's page names the file — a positive marker, not a status code.
  const recipient = await context.newPage();
  await recipient.goto(link);
  await expect(recipient.getByText('report.txt').first()).toBeVisible();

  // And it is at the top of "Recently sent", with a copyable link.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByText('report.txt').first()).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Copy link' }).first()).toBeVisible();
});

test('recipients are emailed', async ({ context, extensionId }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('input[type=file]').setInputFiles([file('for-you.txt')]);
  await panel.getByLabel(/Email to/).fill('friend@yungle.test');
  await panel.getByLabel(/Email to/).press('Enter');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByText('Emailed to friend@yungle.test.')).toBeVisible({ timeout: 30_000 });
});

test('an end-to-end encrypted send puts the key in the link and nowhere else', async ({ context, extensionId }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('input[type=file]').setInputFiles([file('secret-plans.txt', 'the plans')]);
  await panel.getByText('End-to-end encrypt').click();
  // Recipients go away: the key cannot be emailed.
  await expect(panel.getByLabel(/Email to/)).toHaveCount(0);
  await panel.getByRole('button', { name: 'Get a link' }).click();

  await expect(panel.getByText('Your link is ready')).toBeVisible({ timeout: 30_000 });
  const link = await panel.getByLabel('Link').inputValue();
  expect(link).toMatch(/#.+/);

  // The recipient's browser opens it with the key from the fragment.
  const recipient = await context.newPage();
  await recipient.goto(link);
  await expect(recipient.getByText('secret-plans.txt').first()).toBeVisible({ timeout: 15_000 });

  // The list knows it cannot hand out a working copy of that link.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByText('Encrypted file').first()).toBeVisible();
});

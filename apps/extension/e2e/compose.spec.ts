import { expect, mintTokens, ORIGIN, seedSignIn, test } from './fixtures';

/**
 * The compose button, on a stand-in for Gmail's compose window: routed at the
 * real hostname so the registered content script and the web-accessible frame
 * behave exactly as they would there. The markup is the minimum the adapter
 * reads; it says nothing about whether live Gmail still looks like this.
 */
const FAKE_GMAIL = `<!doctype html><html><body>
  <div class="compose">
    <table><tbody><tr class="btC"><td><div role="button">Send</div></td></tr></tbody></table>
    <div g_editable="true" contenteditable="true" role="textbox" style="width:500px;height:200px">Hi, here are the files: </div>
  </div>
</body></html>`;

test('the Gmail button uploads and puts the link into the email', async ({ context, worker }) => {
  await seedSignIn(worker, mintTokens('ext-compose@yungle.test'));
  await context.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: FAKE_GMAIL }));

  const mail = await context.newPage();
  await mail.goto('https://mail.google.com/mail/u/0/');
  const button = mail.getByRole('button', { name: 'Send big files with Yungle' });
  await expect(button).toBeVisible({ timeout: 10_000 });
  // Put the caret at the end of the body, where a person would be typing.
  await mail.locator('[g_editable]').click();
  await mail.keyboard.press('End');
  await button.click();

  // The dialog lives in a CLOSED shadow root (the page cannot reach into it),
  // which selectors cannot pierce either — find its frame by URL instead.
  await expect.poll(() => Boolean(mail.frame({ url: /\/compose\.html$/ }))).toBe(true);
  const dialog = mail.frame({ url: /\/compose\.html$/ })!;
  await dialog.locator('input[type=file]').setInputFiles({ name: 'big-video.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(2048, 1) });
  await dialog.getByRole('button', { name: 'Upload and add to email' }).click();

  const body = mail.locator('[g_editable]');
  await expect(body.locator(`a[href^="${ORIGIN}/t/"]`)).toBeVisible({ timeout: 30_000 });
  await expect(body).toContainText('big-video.mov');
  await expect(body).toContainText('Hi, here are the files:');
});

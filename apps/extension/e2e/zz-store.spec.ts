import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cardHtml } from '../lib/link-card';

const OUT = process.env.OUT!;
const EXT = resolve(import.meta.dirname, '../.output-e2e/chrome-mv3');
const f = (name: string, _mb: number) => '/private/tmp/claude-501/-Users-heindewilde-Projects-yungle/1c41b7b3-89a2-4fd4-b696-703ff187f89d/scratchpad/store/files/' + name;

test('store captures', async () => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'y-')), {
    channel: 'chromium', deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const id = new URL(sw.url()).host;
  await sw.evaluate(() => (globalThis as any).chrome.storage.local.set({ auth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 36e5 } }));
  await new Promise((r) => setTimeout(r, 1500));

  // Side panel, filled in.
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 640 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.locator('input[type=file]').setInputFiles([f('Wedding film – final cut.mov', 96), f('Photos (RAW).zip', 64), f('Contract.pdf', 0.3)]);
  await panel.getByLabel(/Email to/).fill('anna@example.com');
  await panel.getByLabel(/Email to/).press('Enter');
  await panel.getByLabel(/Message/).fill('Here you go — enjoy!');
  await panel.waitForTimeout(500);
  await panel.screenshot({ path: `${OUT}/panel.png` });
  // Same, encryption on.
  await panel.getByText('End-to-end encrypt').click();
  await panel.getByLabel(/Message/).fill('');
  await panel.waitForTimeout(500);
  await panel.screenshot({ path: `${OUT}/panel-e2e.png` });

  // Gmail stand-in: the quiet icon, then the dialog, then an inserted card.
  const card = cardHtml({ link: 'https://yungle.co/t/misty-trail', fileNames: ['Wedding film – final cut.mov', 'Photos (RAW).zip'], totalBytes: 4.2 * 1024 ** 3, expiresAt: '2026-10-13T12:00:00Z', e2ee: false, locale: 'en-GB' });
  const gmail = (body: string) => `<!doctype html><meta charset="utf-8"><body style="font-family:Arial,sans-serif;background:#f6f8fc;margin:0;padding:24px"><div style="background:#fff;border-radius:10px;width:600px;box-shadow:0 2px 10px #0002;overflow:hidden"><div style="background:#f2f6fc;padding:12px 16px;font-size:14px">New Message</div><div style="padding:8px 16px;border-bottom:1px solid #eee;color:#555;font-size:14px">To &nbsp;anna@example.com</div><div style="padding:8px 16px;border-bottom:1px solid #eee;font-size:14px">The wedding files</div><div g_editable="true" contenteditable="true" role="textbox" style="min-height:230px;padding:14px 16px;font-size:14px;color:#202124">${body}</div><table style="width:100%"><tbody><tr class="btC"><td style="padding:10px 16px;width:1%"><div role="button" style="background:#0b57d0;color:#fff;border-radius:18px;padding:9px 22px;display:inline-block;font-size:14px;font-weight:bold">Send</div></td></tr></tbody></table></div></body>`;
  let page = gmail('Hi Anna,<br><br>The files are too big to attach, so here’s a link:<br>');
  await ctx.route('https://mail.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: page }));
  const mail = await ctx.newPage();
  await mail.setViewportSize({ width: 660, height: 440 });
  await mail.goto('https://mail.google.com/mail/u/0/');
  const btn = mail.getByRole('button', { name: 'Send big files with Yungle' });
  await expect(btn).toBeVisible();
  await btn.hover();
  await mail.waitForTimeout(400);
  await mail.screenshot({ path: `${OUT}/gmail-icon.png` });
  await mail.setViewportSize({ width: 900, height: 640 });
  await btn.click();
  await expect.poll(() => Boolean(mail.frame({ url: /compose\.html$/ }))).toBe(true);
  const dlg = mail.frame({ url: /compose\.html$/ })!;
  await dlg.locator('input[type=file]').setInputFiles([f('Wedding film – final cut.mov', 96), f('Photos (RAW).zip', 64)]);
  await mail.waitForTimeout(800);
  await mail.screenshot({ path: `${OUT}/gmail-dialog.png` });

  page = gmail(`Hi Anna,<br><br>The files are too big to attach, so here’s a link:<br>${card}<br>See you Saturday, Sam`);
  const mail2 = await ctx.newPage();
  await mail2.setViewportSize({ width: 660, height: 520 });
  await mail2.goto('https://mail.google.com/mail/u/1/');
  await mail2.getByRole('button', { name: 'Send big files with Yungle' }).waitFor();
  await mail2.waitForTimeout(400);
  await mail2.screenshot({ path: `${OUT}/gmail-card.png` });

  // Popup with a recent list: answer the list call with sample data.
  await ctx.route('**/api/v1/transfers?**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ nextCursor: null, transfers: [
    { id: '1', slug: 'a', url: 'https://yungle.co/t/a', title: null, status: 'active', sizeBytes: 4.2 * 1024 ** 3, fileCount: 2, firstFileName: 'Wedding film – final cut.mov', e2ee: false, recipients: [], downloadCount: 3, maxDownloads: null, finalizedAt: '2026-09-29T10:00:00Z', expiresAt: '2026-10-06T10:00:00Z', createdAt: '2026-09-29T10:00:00Z' },
    { id: '2', slug: 'b', url: 'https://yungle.co/t/b', title: null, status: 'active', sizeBytes: 820 * 1024 ** 2, fileCount: 1, firstFileName: 'encrypted', e2ee: true, recipients: [], downloadCount: 1, maxDownloads: null, finalizedAt: '2026-09-28T10:00:00Z', expiresAt: '2026-10-05T10:00:00Z', createdAt: '2026-09-28T10:00:00Z' },
    { id: '3', slug: 'c', url: 'https://yungle.co/t/c', title: 'Brand assets Q4', status: 'active', sizeBytes: 1.1 * 1024 ** 3, fileCount: 14, firstFileName: 'logo.svg', e2ee: false, recipients: [], downloadCount: 8, maxDownloads: null, finalizedAt: '2026-09-27T10:00:00Z', expiresAt: '2026-10-27T10:00:00Z', createdAt: '2026-09-27T10:00:00Z' },
  ] }) }));
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 340, height: 360 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByText('Brand assets Q4').waitFor();
  await popup.screenshot({ path: `${OUT}/popup.png` });
  await ctx.close();
});

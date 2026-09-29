import { handleTabUrl } from '@/lib/auth';
import { syncComposeScripts } from '@/lib/webmail';

export default defineBackground(() => {
  // Sign-in finishes wherever the redirect page opens — the consent tab, or a
  // new tab from the sign-in email. Registered at the top level so a suspended
  // background is woken for it.
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) void handleTabUrl(tabId, change.url);
  });

  // The compose button's scripts follow its permissions, whichever page
  // granted or revoked them (including the browser's own extension settings).
  browser.runtime.onInstalled.addListener(() => void syncComposeScripts());
  browser.runtime.onStartup.addListener(() => void syncComposeScripts());
  browser.permissions.onAdded.addListener(() => void syncComposeScripts());
  browser.permissions.onRemoved.addListener(() => void syncComposeScripts());

  // The compose dialog asks for a desktop notification when its upload
  // finishes; only an extension context may show one.
  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; title?: string; message?: string };
    if (m.type === 'notify' && m.title) {
      void browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: m.title,
        message: m.message ?? '',
      });
    }
  });
});

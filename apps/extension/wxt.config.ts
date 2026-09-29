import { defineConfig } from 'wxt';

/**
 * Where Yungle lives. Production is yungle.co; a local build points at a dev
 * server (`WXT_YUNGLE_ORIGIN=http://localhost:3002`) and its upload service.
 */
const ORIGIN = process.env.WXT_YUNGLE_ORIGIN ?? 'https://yungle.co';
const TUS_ORIGIN = process.env.WXT_YUNGLE_TUS_ORIGIN ?? ORIGIN;

/**
 * Gmail and Outlook on the web. OPTIONAL: asked for only when the person turns
 * on the compose button, so installing the extension never shows "read and
 * change your data on mail.google.com". Content scripts for them are
 * registered at runtime for the same reason — a static `content_scripts` entry
 * would make these hosts a required permission.
 */
export const WEBMAIL_HOSTS = [
  'https://mail.google.com/*',
  'https://outlook.live.com/*',
  'https://outlook.office.com/*',
  'https://outlook.office365.com/*',
];

/**
 * The browser tests' build: its own output directory, so it can never be the
 * one that is zipped, and the webmail hosts granted up front — a test cannot
 * click a permission prompt.
 */
const E2E = process.env.WXT_E2E === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: E2E ? '.output-e2e' : '.output',
  hooks: {
    // WXT adds a runtime content script's `matches` to the REQUIRED host
    // permissions. These must stay optional — asked for when the compose button
    // is switched on — so take them back out.
    'build:manifestGenerated': (_wxt, manifest) => {
      if (!E2E) manifest.host_permissions = manifest.host_permissions?.filter((h: string) => !WEBMAIL_HOSTS.includes(h));
    },
  },
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'Yungle',
    description: 'Send big files from your browser, and from Gmail and Outlook. Private, EU-hosted, always encrypted.',
    permissions: ['storage', 'notifications', 'scripting', ...(browser === 'firefox' ? [] : ['sidePanel'])],
    host_permissions: [...new Set([`${ORIGIN}/*`, `${TUS_ORIGIN}/*`])],
    optional_host_permissions: WEBMAIL_HOSTS,
    action: { default_title: 'Yungle' },
    // The compose dialog is framed inside Gmail/Outlook, so those pages must be
    // allowed to load it. Nothing else is exposed.
    web_accessible_resources: [{ resources: ['compose.html'], matches: WEBMAIL_HOSTS }],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'browser@yungle.co',
              strict_min_version: '128.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : { minimum_chrome_version: '116' }),
  }),
});

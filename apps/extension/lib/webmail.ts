/**
 * The Gmail/Outlook compose button: its permissions and its content scripts.
 *
 * Both are optional and asked for only when the person turns the button on.
 * The scripts are registered at runtime, never in the manifest — a static
 * `content_scripts` entry would make these hosts a required permission and put
 * "read and change your data on mail.google.com" on the install screen.
 */

export const CLIENTS = {
  gmail: { label: 'Gmail', origins: ['https://mail.google.com/*'], js: 'content-scripts/gmail.js' },
  outlook: {
    label: 'Outlook',
    origins: ['https://outlook.live.com/*', 'https://outlook.office.com/*', 'https://outlook.office365.com/*'],
    js: 'content-scripts/outlook.js',
  },
} as const;

export type MailClient = keyof typeof CLIENTS;

export async function isEnabled(client: MailClient): Promise<boolean> {
  return browser.permissions.contains({ origins: [...CLIENTS[client].origins] });
}

/** Must run inside a click handler: browsers only show the prompt for a user gesture. */
export async function enable(client: MailClient): Promise<boolean> {
  return browser.permissions.request({ origins: [...CLIENTS[client].origins] });
}

export async function disable(client: MailClient): Promise<void> {
  await browser.permissions.remove({ origins: [...CLIENTS[client].origins] });
}

/** Background: make the registered scripts match the granted permissions. */
export async function syncComposeScripts(): Promise<void> {
  const registered = new Set((await browser.scripting.getRegisteredContentScripts()).map((s) => s.id));
  for (const [id, c] of Object.entries(CLIENTS) as Array<[MailClient, (typeof CLIENTS)[MailClient]]>) {
    const granted = await isEnabled(id);
    if (granted && !registered.has(id)) {
      await browser.scripting.registerContentScripts([
        { id, matches: [...c.origins], js: [c.js], runAt: 'document_idle', persistAcrossSessions: true },
      ]);
    } else if (!granted && registered.has(id)) {
      await browser.scripting.unregisterContentScripts({ ids: [id] });
    }
  }
}

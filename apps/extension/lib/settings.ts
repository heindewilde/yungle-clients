export type LinkStyle = 'card' | 'plain';

const KEY = 'linkStyle';

export async function getLinkStyle(): Promise<LinkStyle> {
  const got = await browser.storage.local.get(KEY);
  return got[KEY] === 'plain' ? 'plain' : 'card';
}

export async function setLinkStyle(style: LinkStyle): Promise<void> {
  await browser.storage.local.set({ [KEY]: style });
}

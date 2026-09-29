/**
 * Messages between the compose dialog (an extension page framed inside Gmail
 * or Outlook) and the content script that framed it.
 *
 * The content script trusts a message only when it comes from ITS iframe's
 * window and from the extension's own origin — a page script cannot forge
 * either. What travels is the link (for an encrypted send, including its key),
 * and it is about to be written into the page's editor anyway, so the page
 * seeing it on the way changes nothing.
 */

export type ComposeMessage =
  | { source: 'yungle'; type: 'insert'; html: string; text: string }
  | { source: 'yungle'; type: 'close' };

export function isComposeMessage(data: unknown): data is ComposeMessage {
  const m = data as Partial<ComposeMessage> | null;
  return !!m && m.source === 'yungle' && (m.type === 'close' || (m.type === 'insert' && typeof (m as { html?: unknown }).html === 'string'));
}

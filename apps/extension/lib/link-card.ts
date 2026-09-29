import { formatBytes, formatUntil } from './format';

/**
 * What the compose button inserts into an email: a small card or a plain line.
 *
 * Email HTML, so: tables-free inline styles only, no images (clients block
 * them, and a remote logo would be a tracking pixel in all but name), no
 * classes, and every piece of text escaped — filenames are user data going
 * into someone else's editor.
 *
 * An end-to-end encrypted send names no files. The sender knows them; writing
 * them into the email would hand them to the mail provider, which is the
 * party the encryption was chosen to keep them from.
 */

export interface CardInput {
  link: string;
  fileNames: string[];
  totalBytes: number;
  expiresAt: string | null;
  e2ee: boolean;
  locale?: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** "holiday.jpg", "holiday.jpg and 2 more", or "3 encrypted files". */
export function summary(input: Pick<CardInput, 'fileNames' | 'e2ee'>): string {
  const n = input.fileNames.length;
  if (input.e2ee) return n === 1 ? '1 encrypted file' : `${n} encrypted files`;
  if (n === 1) return input.fileNames[0]!;
  return `${input.fileNames[0]} and ${n - 1} more`;
}

export function plainText(input: CardInput): string {
  const until = input.expiresAt ? `, until ${formatUntil(input.expiresAt, input.locale)}` : '';
  return `${summary(input)} (${formatBytes(input.totalBytes)}), via Yungle${until}: ${input.link}`;
}

export function cardHtml(input: CardInput): string {
  const until = input.expiresAt ? ` · available until ${escapeHtml(formatUntil(input.expiresAt, input.locale))}` : '';
  const href = escapeHtml(input.link);
  const title = escapeHtml(summary(input));
  const size = escapeHtml(formatBytes(input.totalBytes));
  return (
    `<div style="border:1px solid #dde6dd;border-radius:12px;padding:14px 16px;margin:8px 0;max-width:420px;font-family:Arial,Helvetica,sans-serif;color:#1e2b24;">` +
    `<div style="font-size:15px;font-weight:bold;margin:0 0 4px;">${title}</div>` +
    `<div style="font-size:13px;color:#4b5a52;margin:0 0 12px;">${size}${until}${input.e2ee ? ' · end-to-end encrypted' : ''}</div>` +
    `<a href="${href}" style="display:inline-block;background:#3ea76a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:9px 16px;border-radius:8px;">Download</a>` +
    `<div style="font-size:11px;color:#7a897f;margin:10px 0 0;">Sent with Yungle</div>` +
    `</div>`
  );
}

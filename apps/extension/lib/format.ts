/** Human sizes — the website's `formatBytes`, copied so a size reads the same in both. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  const s = value.toFixed(value < 10 && i > 0 ? 1 : 0);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s} ${units[i]}`;
}

/** "Available until 6 October", in the reader's language. */
export function formatUntil(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'long' });
}

/** Expiry choices a plan allows. Free is always 7 days; the server clamps anyway. */
export function expiryOptions(paid: boolean): number[] {
  return paid ? [7, 30, 90, 365] : [7];
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

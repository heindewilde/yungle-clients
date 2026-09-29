import { describe, expect, it } from 'vitest';
import { cardHtml, plainText, summary } from './link-card';

const base = { link: 'https://yungle.co/t/abc', totalBytes: 5 * 1024 ** 3, expiresAt: '2026-10-06T12:00:00Z', locale: 'en-GB' };

describe('the email card', () => {
  it('summarises one or many files', () => {
    expect(summary({ fileNames: ['a.mov'], e2ee: false })).toBe('a.mov');
    expect(summary({ fileNames: ['a.mov', 'b.mov', 'c.mov'], e2ee: false })).toBe('a.mov and 2 more');
  });

  it('never names an encrypted file — the mail provider would read it', () => {
    const input = { ...base, fileNames: ['secret-plans.pdf'], e2ee: true };
    expect(cardHtml(input)).not.toContain('secret-plans');
    expect(plainText(input)).not.toContain('secret-plans');
    expect(summary(input)).toBe('1 encrypted file');
  });

  it('escapes everything it inserts', () => {
    const html = cardHtml({ ...base, fileNames: ['<img src=x onerror=alert(1)>.png'], e2ee: false, link: 'https://yungle.co/t/a"onmouseover="x' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('"onmouseover');
    expect(html).toContain('&lt;img');
  });

  it('carries the link, size and expiry in both forms', () => {
    const input = { ...base, fileNames: ['a.mov'], e2ee: false };
    expect(plainText(input)).toBe('a.mov (5 GB), via Yungle, until 6 October: https://yungle.co/t/abc');
    expect(cardHtml(input)).toContain('href="https://yungle.co/t/abc"');
  });
});

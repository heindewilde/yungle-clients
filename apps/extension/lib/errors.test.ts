import { describe, expect, it } from 'vitest';
import { explainError } from './errors';

describe('explaining failures', () => {
  it('turns a sign-out into a sign-in action', () => {
    expect(explainError({ name: 'SignedOutError' }).action?.signIn).toBe(true);
    expect(explainError({ code: 'unauthorized', status: 401 }).action?.signIn).toBe(true);
  });

  it('points at plans where money is the way through', () => {
    for (const code of ['transfer_too_large', 'quota_exceeded', 'upgrade_required', 'rate_limited']) {
      expect(explainError({ code }).action?.url).toContain('/pricing');
    }
    expect(explainError({ name: 'UploadError', status: 413 }).action?.url).toContain('/pricing');
  });

  it('never shows a raw error', () => {
    const e = explainError(new Error('ECONNRESET at socket.js:123'));
    expect(e.message).not.toContain('ECONNRESET');
  });

  it('keeps our own people-facing server copy', () => {
    expect(explainError({ code: 'upgrade_required', message: 'Free uploads are paused for the rest of the month.' }).message).toBe(
      'Free uploads are paused for the rest of the month.',
    );
  });
});

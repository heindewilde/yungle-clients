import { PRICING_URL } from './config';

/**
 * Any failure → a sentence a person can act on, plus the one action that
 * helps. Never a raw API error: the codes are for us, the sentence is for them.
 *
 * Pure (duck-typed rather than `instanceof`), so it is tested without the SDK
 * or a browser.
 */

export interface Explained {
  message: string;
  action?: { label: string; url?: string; signIn?: true };
}

type Coded = { name?: string; code?: string; status?: number; message?: string };

const PLANS = { label: 'See plans', url: PRICING_URL };

export function explainError(err: unknown): Explained {
  const e = (err ?? {}) as Coded;

  if (e.name === 'SignedOutError' || e.code === 'unauthorized') {
    return { message: 'You’re signed out of Yungle.', action: { label: 'Sign in', signIn: true } };
  }
  if (e.name === 'UploadError') {
    if (e.status === -1) return { message: 'Cancelled.' };
    if (e.status === 0) return { message: 'The connection dropped and didn’t come back. Try again when you’re online.' };
    if (e.status === 413) return { message: 'That’s more than your plan can send at once.', action: PLANS };
    return { message: 'The upload didn’t go through. Try again in a moment.' };
  }

  switch (e.code) {
    case 'transfer_too_large':
    case 'quota_exceeded':
      return { message: 'That’s more than your plan can send at once.', action: PLANS };
    case 'upgrade_required':
      // Our own server messages for these are written for people; show them.
      return { message: e.message || 'That needs a paid plan.', action: PLANS };
    case 'rate_limited':
      return { message: e.message || 'Too many sends for now. Try again in a little while.', action: PLANS };
    case 'email_budget_exhausted':
      return { message: 'Today’s limit for emailing people is used up. Copy the link and share it yourself.' };
    case 'insufficient_scope':
      return { message: 'This sign-in can’t email people. Sign in again and allow it.', action: { label: 'Sign in', signIn: true } };
    case 'invalid_request':
      return { message: e.message || 'Something in that send wasn’t accepted.' };
  }

  if (e.message === 'offline' || e.name === 'TypeError') {
    return { message: 'Couldn’t reach Yungle. Check your connection and try again.' };
  }
  return { message: 'Something went wrong on our side. Try again in a moment.' };
}

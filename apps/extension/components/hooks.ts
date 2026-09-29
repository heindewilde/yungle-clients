import { useEffect, useState } from 'react';
import type { Contact, Me } from 'yungle-client';
import { api } from '@/lib/api';
import { onAuthChange, readTokens } from '@/lib/auth';

/** null while reading storage, then whether a sign-in exists (in any context). */
export function useSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    void readTokens().then((t) => setSignedIn(Boolean(t)));
    return onAuthChange(setSignedIn);
  }, []);
  return signedIn;
}

export function useMe(enabled: boolean): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!enabled) return;
    void api()
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, [enabled]);
  return me;
}

/** A paid plan: longer expiry choices. Free has no tier. */
export function isPaid(me: Me | null): boolean {
  return Boolean(me?.plan.tier) && me?.plan.status !== 'canceled';
}

/** The address book, for recipient suggestions. Loaded once; failures mean no suggestions. */
export function useContacts(enabled: boolean): Contact[] {
  const [contacts, setContacts] = useState<Contact[]>([]);
  useEffect(() => {
    if (!enabled) return;
    void api()
      .listContacts()
      .then((r) => setContacts(r.contacts))
      .catch(() => undefined);
  }, [enabled]);
  return contacts;
}

import { useEffect, useState } from 'react';
import { signOut } from '@/lib/auth';
import { CLIENTS, disable, enable, isEnabled, type MailClient } from '@/lib/webmail';
import { getLinkStyle, setLinkStyle, type LinkStyle } from '@/lib/settings';

/** The compose-button switches, the link style, and sign-out. */
export function Settings() {
  const [on, setOn] = useState<Record<MailClient, boolean>>({ gmail: false, outlook: false });
  const [style, setStyle] = useState<LinkStyle>('card');

  useEffect(() => {
    void Promise.all([isEnabled('gmail'), isEnabled('outlook')]).then(([gmail, outlook]) => setOn({ gmail, outlook }));
    void getLinkStyle().then(setStyle);
  }, []);

  const toggle = async (client: MailClient, next: boolean) => {
    // `permissions.request` must be the first thing in the click handler.
    const ok = next ? await enable(client) : (await disable(client), true);
    if (ok) setOn((o) => ({ ...o, [client]: next }));
  };

  return (
    <div className="stack">
      <div>
        <div className="label">Yungle button when writing an email</div>
        {(Object.keys(CLIENTS) as MailClient[]).map((c) => (
          <label key={c} className="switch" style={{ padding: '4px 0' }}>
            <input type="checkbox" checked={on[c]} onChange={(e) => void toggle(c, e.target.checked)} />
            <span>{CLIENTS[c].label}</span>
          </label>
        ))}
        <p className="faint" style={{ margin: '4px 0 0' }}>
          Your browser asks first. The button only adds a link to the email you’re writing; it never reads your mail.
        </p>
      </div>
      <div>
        <div className="label">Links in emails look like</div>
        <div className="row">
          {(['card', 'plain'] as const).map((s) => (
            <label key={s} className="switch">
              <input
                type="radio"
                name="style"
                checked={style === s}
                onChange={() => {
                  setStyle(s);
                  void setLinkStyle(s);
                }}
              />
              <span>{s === 'card' ? 'A small card' : 'A plain link'}</span>
            </label>
          ))}
        </div>
      </div>
      <button type="button" className="link-btn" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

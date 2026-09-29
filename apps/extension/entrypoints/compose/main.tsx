import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/theme.css';
import { Composer } from '@/components/Composer';
import { useSignedIn } from '@/components/hooks';
import { SignIn } from '@/components/SignIn';
import { Wordmark } from '@/components/Wordmark';
import type { ComposeMessage } from '@/lib/compose-protocol';
import { cardHtml, plainText } from '@/lib/link-card';
import { getLinkStyle } from '@/lib/settings';

/** The dialog framed inside Gmail/Outlook. Uploads here, then hands the link to the email. */

const post = (m: ComposeMessage) => window.parent.postMessage(m, '*');

function Dialog() {
  const signedIn = useSignedIn();
  return (
    <div className="stack" style={{ padding: 16 }}>
      <div className="spread">
        <Wordmark />
        <button type="button" className="link-btn" aria-label="Close" onClick={() => post({ source: 'yungle', type: 'close' })}>
          Close
        </button>
      </div>
      {signedIn === false && <SignIn compact />}
      {signedIn && (
        <Composer
          mode="compose"
          onResult={async (r) => {
            const card = { ...r, locale: navigator.language };
            const style = await getLinkStyle();
            const text = plainText(card);
            post({ source: 'yungle', type: 'insert', html: style === 'card' ? cardHtml(card) : '', text });
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dialog />
  </StrictMode>,
);

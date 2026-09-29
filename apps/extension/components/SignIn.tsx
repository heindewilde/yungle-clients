import { useState } from 'react';
import { startSignIn } from '@/lib/auth';
import { Wordmark } from './Wordmark';

/**
 * Signed out. "Connect" opens yungle.co in a tab; if they are not signed in
 * there, they get the usual email link, and the extension picks the sign-in up
 * from whichever tab it finishes in.
 */
export function SignIn({ compact = false }: { compact?: boolean }) {
  const [started, setStarted] = useState(false);
  return (
    <div className="stack" style={{ padding: compact ? 16 : 24, textAlign: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Wordmark height={compact ? 22 : 28} />
      </div>
      <p className="muted" style={{ margin: '12px 0 0' }}>
        Send big files straight from your browser. Private, EU-hosted, always encrypted.
      </p>
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => {
          setStarted(true);
          void startSignIn();
        }}
      >
        Sign in with Yungle
      </button>
      {started ? (
        <p className="faint">
          Finish in the tab that just opened. If we emailed you a sign-in link, open it — this updates by itself.
        </p>
      ) : (
        <p className="faint">No account yet? Signing in creates a free one.</p>
      )}
    </div>
  );
}

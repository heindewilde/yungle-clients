import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/theme.css';
import { useSignedIn } from '@/components/hooks';
import { Recent } from '@/components/Recent';
import { SignIn } from '@/components/SignIn';
import { Wordmark } from '@/components/Wordmark';
import { openPanel, rememberWindow } from '@/lib/panel';

rememberWindow();

function Popup() {
  const signedIn = useSignedIn();
  if (signedIn === null) return null;
  if (!signedIn) return <SignIn compact />;
  return (
    <div className="stack" style={{ padding: 16 }}>
      <div className="spread">
        <Wordmark />
        <button type="button" className="link-btn" onClick={() => openPanel('settings')}>
          Settings
        </button>
      </div>
      <button type="button" className="btn btn-primary btn-block" onClick={() => openPanel('send')}>
        Send files
      </button>
      <div>
        <div className="label">Recently sent</div>
        <Recent />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ width: 340 }}>
      <Popup />
    </div>
  </StrictMode>,
);

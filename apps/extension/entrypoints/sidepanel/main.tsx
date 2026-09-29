import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/theme.css';
import { Composer } from '@/components/Composer';
import { useSignedIn } from '@/components/hooks';
import { Settings } from '@/components/Settings';
import { SignIn } from '@/components/SignIn';
import { Wordmark } from '@/components/Wordmark';
import { onPanelView, readPanelView, type PanelView } from '@/lib/panel';

function Panel() {
  const signedIn = useSignedIn();
  const [view, setView] = useState<PanelView>('send');
  useEffect(() => {
    void readPanelView().then(setView);
    return onPanelView(setView);
  }, []);

  if (signedIn === null) return null;
  if (!signedIn) return <SignIn />;
  return (
    <div className="stack" style={{ padding: 16 }}>
      <div className="spread">
        <Wordmark />
        <div className="row" role="tablist">
          {(['send', 'settings'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={`btn btn-small ${view === v ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setView(v)}
            >
              {v === 'send' ? 'Send' : 'Settings'}
            </button>
          ))}
        </div>
      </div>
      {/* Hidden, not unmounted: switching to Settings must not kill an upload. */}
      <div hidden={view !== 'send'}>
        <Composer mode="panel" />
      </div>
      {view === 'settings' && <Settings />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);

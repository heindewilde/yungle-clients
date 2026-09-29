import { useEffect, useState } from 'react';
import type { TransferSummary } from 'yungle-client';
import { api } from '@/lib/api';
import { DASHBOARD_URL } from '@/lib/config';
import { explainError, type Explained } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { ErrorLine } from './Composer';

/** Its title, else what was sent: "Contract.pdf and 2 more". An encrypted one has no readable names. */
function label(t: TransferSummary): string {
  if (t.title) return t.title;
  if (t.e2ee) return t.fileCount === 1 ? 'Encrypted file' : `${t.fileCount} encrypted files`;
  if (!t.firstFileName) return 'Transfer';
  return t.fileCount > 1 ? `${t.firstFileName} and ${t.fileCount - 1} more` : t.firstFileName;
}

/** The last few sent transfers, with their links. Drafts are not shareable, so they are left out. */
export function Recent() {
  const [items, setItems] = useState<TransferSummary[] | null>(null);
  const [error, setError] = useState<Explained | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    api()
      .listTransfers({ limit: 20 })
      .then((r) => setItems(r.transfers.filter((t) => t.finalizedAt && t.status === 'active').slice(0, 5)))
      .catch((e) => setError(explainError(e)));
  }, []);

  if (error) return <ErrorLine error={error} />;
  if (!items) return <p className="faint">Loading…</p>;
  if (items.length === 0) return <p className="faint">Nothing sent yet.</p>;

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((t) => (
        <li key={t.id} className="spread" style={{ padding: '7px 0', borderTop: '1px solid var(--c-hairline)' }}>
          <div className="truncate">
            <div className="truncate">{label(t)}</div>
            <div className="faint">
              {formatBytes(t.sizeBytes)} · {t.downloadCount} {t.downloadCount === 1 ? 'download' : 'downloads'}
            </div>
          </div>
          {t.e2ee ? (
            // Its working link carries a key we never stored; copying `url`
            // would hand out a link that cannot open anything.
            <span className="faint" title="The key was only in the link you shared">
              🔒
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => {
                void navigator.clipboard.writeText(t.url);
                setCopied(t.id);
              }}
            >
              {copied === t.id ? 'Copied' : 'Copy link'}
            </button>
          )}
        </li>
      ))}
      <li style={{ paddingTop: 8 }}>
        <a className="faint" href={`${DASHBOARD_URL}/transfers`} target="_blank" rel="noreferrer">
          All transfers
        </a>
      </li>
    </ul>
  );
}

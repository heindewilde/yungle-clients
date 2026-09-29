import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { startSignIn } from '@/lib/auth';
import { DASHBOARD_URL } from '@/lib/config';
import { explainError, type Explained } from '@/lib/errors';
import { expiryOptions, formatBytes, isEmail } from '@/lib/format';
import { send, type SendHandle, type SendProgress, type SendResult } from '@/lib/send';
import { isPaid, useContacts, useMe } from './hooks';

/**
 * The composer, in two places:
 *
 * - `panel` (the side panel): recipients, message, Send, then a link to copy.
 * - `compose` (the dialog inside Gmail/Outlook): no recipients — the email the
 *   person is writing IS the delivery — and the result goes into that email.
 *
 * Uploads run in THIS page. The side panel and the dialog both stay open while
 * someone keeps working, which a toolbar popup does not (it dies on blur).
 */

type Mode = 'panel' | 'compose';

type Stage =
  | { kind: 'edit' }
  | { kind: 'sending'; progress: SendProgress }
  | { kind: 'done'; result: SendResult }
  | { kind: 'error'; error: Explained };

export function Composer({ mode, onResult }: { mode: Mode; onResult?: (r: SendResult) => void }) {
  const me = useMe(true);
  const paid = isPaid(me);
  const contacts = useContacts(mode === 'panel');

  const [files, setFiles] = useState<File[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [e2ee, setE2ee] = useState(false);
  const [days, setDays] = useState(7);
  const [stage, setStage] = useState<Stage>({ kind: 'edit' });
  const [dragging, setDragging] = useState(false);
  const handle = useRef<SendHandle | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const total = files.reduce((s, f) => s + f.size, 0);
  const canEmail = mode === 'panel' && !e2ee;

  // An upload in flight dies with this page; say so before it is closed.
  useEffect(() => {
    if (stage.kind !== 'sending') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [stage.kind]);

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const incoming = [...list];
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}:${f.lastModified}`))];
    });
  };

  const commitDraft = () => {
    const parts = draft.split(/[\s,;]+/).filter(Boolean);
    const good = parts.filter(isEmail).map((p) => p.toLowerCase());
    if (good.length) setRecipients((r) => [...new Set([...r, ...good])]);
    setDraft(parts.filter((p) => !isEmail(p)).join(' '));
  };

  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      if (draft.trim()) {
        e.preventDefault();
        commitDraft();
      }
    } else if (e.key === 'Backspace' && !draft && recipients.length) {
      setRecipients((r) => r.slice(0, -1));
    }
  };

  const start = async () => {
    const pending = draft.trim() && isEmail(draft) ? [draft.trim().toLowerCase()] : [];
    const to = canEmail ? [...new Set([...recipients, ...pending])] : [];
    setStage({ kind: 'sending', progress: { phase: 'preparing', sent: 0, total, reconnecting: false } });
    void browser.action?.setBadgeText({ text: '↑' }).catch(() => undefined);
    const startedAt = Date.now();
    handle.current = send(
      {
        files: files.map((file) => ({ file })),
        e2ee,
        recipients: to,
        message: mode === 'panel' ? message : '',
        ...(paid ? { expiresInDays: days } : {}),
      },
      (progress) => setStage({ kind: 'sending', progress }),
    );
    try {
      const result = await handle.current.done;
      setStage({ kind: 'done', result });
      onResult?.(result);
      // Worth interrupting for only if they have looked away.
      if (!document.hasFocus() || Date.now() - startedAt > 15_000) {
        notify('Your files are ready', result.emailed.length ? `Sent to ${result.emailed.join(', ')}` : 'The link is ready to share.');
      }
    } catch (err) {
      setStage({ kind: 'error', error: explainError(err) });
    } finally {
      handle.current = null;
      void browser.action?.setBadgeText({ text: '' }).catch(() => undefined);
    }
  };

  const reset = () => {
    setFiles([]);
    setRecipients([]);
    setDraft('');
    setMessage('');
    setStage({ kind: 'edit' });
  };

  if (stage.kind === 'sending') return <Sending progress={stage.progress} onCancel={() => handle.current?.cancel()} />;
  if (stage.kind === 'done') return mode === 'panel' ? <Done result={stage.result} onAgain={reset} /> : <Inserted onAgain={reset} />;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div className="stack">
      <div
        className="card"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          padding: 16,
          borderStyle: files.length ? 'solid' : 'dashed',
          borderColor: dragging ? 'var(--c-emerald)' : undefined,
          textAlign: files.length ? 'left' : 'center',
        }}
      >
        <input ref={picker} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
        {files.length === 0 ? (
          <>
            <p style={{ margin: '6px 0 12px' }}>Drop files here</p>
            <button type="button" className="btn btn-ghost" onClick={() => picker.current?.click()}>
              Choose files
            </button>
          </>
        ) : (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 180, overflowY: 'auto' }}>
              {files.map((f, i) => (
                <li key={`${f.name}:${i}`} className="spread" style={{ padding: '4px 0' }}>
                  <span className="truncate">{f.name}</span>
                  <span className="row faint">
                    {formatBytes(f.size)}
                    <button
                      type="button"
                      className="link-btn"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="spread" style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => picker.current?.click()}>
                Add more
              </button>
              <span className="faint">
                {files.length} {files.length === 1 ? 'file' : 'files'} · {formatBytes(total)}
              </span>
            </div>
          </>
        )}
      </div>

      {canEmail && (
        <div>
          <label className="label" htmlFor="to">
            Email to <span className="faint">(optional — or just copy the link)</span>
          </label>
          {recipients.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
              {recipients.map((r) => (
                <span key={r} className="chip">
                  {r}
                  <button type="button" aria-label={`Remove ${r}`} onClick={() => setRecipients((all) => all.filter((x) => x !== r))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            id="to"
            className="input"
            list="contacts"
            placeholder="name@example.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            onBlur={commitDraft}
            autoComplete="off"
          />
          <datalist id="contacts">
            {contacts.map((c) => (
              <option key={c.id} value={c.email}>
                {[c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || ''}
              </option>
            ))}
          </datalist>
        </div>
      )}

      {mode === 'panel' && (
        <div>
          <label className="label" htmlFor="msg">
            Message <span className="faint">(optional)</span>
          </label>
          <textarea id="msg" className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />
        </div>
      )}

      {paid && (
        <div>
          <label className="label" htmlFor="days">
            Available for
          </label>
          <select id="days" className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {expiryOptions(true).map((d) => (
              <option key={d} value={d}>
                {d === 365 ? '1 year' : `${d} days`}
              </option>
            ))}
          </select>
        </div>
      )}

      <label className="switch">
        <input type="checkbox" checked={e2ee} onChange={(e) => setE2ee(e.target.checked)} />
        <span>
          End-to-end encrypt
          <span className="faint" style={{ display: 'block' }}>
            {e2ee
              ? mode === 'compose'
                ? 'The key is part of the link, so it will be in your email. There are no previews, and Yungle can’t recover a lost link.'
                : 'The key is part of the link, so share it yourself — Yungle can’t email it. There are no previews, and a lost link can’t be recovered.'
              : 'Off: files are always encrypted at Yungle, with previews and virus scanning.'}
          </span>
        </span>
      </label>

      {!paid && me && <p className="faint">Free plan: available for 7 days.</p>}

      <button type="button" className="btn btn-primary btn-block" disabled={files.length === 0} onClick={() => void start()}>
        {mode === 'compose' ? 'Upload and add to email' : recipients.length || (draft && isEmail(draft)) ? 'Send' : 'Get a link'}
      </button>

      {stage.kind === 'error' && <ErrorLine error={stage.error} />}
    </div>
  );
}

function Sending({ progress, onCancel }: { progress: SendProgress; onCancel: () => void }) {
  const pct = progress.total ? Math.min(100, Math.round((progress.sent / progress.total) * 100)) : 0;
  const label =
    progress.phase === 'preparing'
      ? 'Getting ready…'
      : progress.phase === 'finishing'
        ? 'Finishing…'
        : progress.reconnecting
          ? 'Connection lost — resuming…'
          : `Uploading · ${formatBytes(progress.sent)} of ${formatBytes(progress.total)}`;
  return (
    <div className="card stack" style={{ padding: 16 }}>
      <div className="spread">
        <strong>{label}</strong>
        <span className="faint">{pct}%</span>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="faint" style={{ margin: 0 }}>
        Keep this open until it’s done. You can keep browsing in other tabs.
      </p>
      <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function Done({ result, onAgain }: { result: SendResult; onAgain: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(result.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="card stack" style={{ padding: 16 }}>
      <strong>{result.emailed.length ? 'Sent' : 'Your link is ready'}</strong>
      {result.emailed.length > 0 && <p className="muted" style={{ margin: 0 }}>Emailed to {result.emailed.join(', ')}.</p>}
      <div className="row">
        <input className="input" readOnly value={result.link} onFocus={(e) => e.target.select()} aria-label="Link" />
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {result.e2ee && (
        <p className="faint" style={{ margin: 0 }}>
          This link holds the key. Yungle can’t show it again or recover it — keep it somewhere safe.
        </p>
      )}
      <div className="spread">
        <button type="button" className="btn btn-ghost btn-small" onClick={onAgain}>
          Send more
        </button>
        <a className="faint" href={`${DASHBOARD_URL}/transfers`} target="_blank" rel="noreferrer">
          Open in Yungle
        </a>
      </div>
    </div>
  );
}

function Inserted({ onAgain }: { onAgain: () => void }) {
  return (
    <div className="card stack" style={{ padding: 16, textAlign: 'center' }}>
      <strong>Added to your email</strong>
      <button type="button" className="btn btn-ghost btn-small" onClick={onAgain}>
        Add more files
      </button>
    </div>
  );
}

export function ErrorLine({ error }: { error: Explained }) {
  return (
    <p className="error" role="alert" style={{ margin: 0 }}>
      {error.message}{' '}
      {error.action?.url && (
        <a href={error.action.url} target="_blank" rel="noreferrer">
          {error.action.label}
        </a>
      )}
      {error.action?.signIn && (
        <button type="button" className="link-btn" onClick={() => void startSignIn()}>
          {error.action.label}
        </button>
      )}
    </p>
  );
}

function notify(title: string, message: string) {
  // Shown by the background: an extension frame inside a web page (the compose
  // dialog) cannot always reach `notifications` itself.
  void browser.runtime.sendMessage({ type: 'notify', title, message }).catch(() => undefined);
}

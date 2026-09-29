import { isComposeMessage } from '@/lib/compose-protocol';
import type { Adapter, ComposeTarget } from './adapters';

/**
 * The page side of the compose button: watch for compose windows, add a
 * button to each, open the dialog, and put what it returns into the email.
 *
 * No network, no storage, no reading the email: this script only ever writes
 * one link into an editor the person is typing in, when they ask.
 */

const MARK = 'data-yungle';

export function run(adapter: Adapter): void {
  const scan = () => {
    for (const target of adapter.find(document)) {
      if (target.editor.hasAttribute(MARK)) continue;
      target.editor.setAttribute(MARK, '1');
      attach(target);
    }
  };
  scan();
  // Compose windows come and go without navigation; coalesce bursts of DOM churn.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }).observe(document.body, { childList: true, subtree: true });
}

function attach({ editor, toolbar }: ComposeTarget): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Yungle';
  button.title = 'Send big files with Yungle';
  button.setAttribute('aria-label', 'Send big files with Yungle');
  Object.assign(button.style, {
    font: '600 13px/1 system-ui, sans-serif',
    color: '#ffffff',
    background: '#3ea76a',
    border: '0',
    borderRadius: '999px',
    padding: '7px 12px',
    margin: '0 6px',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);

  let saved: Range | null = null;
  // mousedown, not click: by click time focus has left the editor and the
  // caret position is gone.
  button.addEventListener('mousedown', () => {
    const sel = window.getSelection();
    saved = sel && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openDialog((html, text) => insert(editor, saved, html, text));
  });

  if (toolbar) {
    const cell = toolbar.tagName === 'TR' ? toolbar.appendChild(document.createElement('td')) : toolbar;
    cell.appendChild(button);
    return;
  }
  // Fallback: float on the editor's bottom-right corner, following it.
  Object.assign(button.style, { position: 'fixed', zIndex: '2147483000', boxShadow: '0 4px 14px rgba(0,0,0,.18)' });
  document.body.appendChild(button);
  const place = () => {
    if (!editor.isConnected) {
      button.remove();
      return;
    }
    const r = editor.getBoundingClientRect();
    const visible = r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    button.style.display = visible ? '' : 'none';
    button.style.left = `${Math.max(8, r.right - button.offsetWidth - 12)}px`;
    button.style.top = `${Math.min(innerHeight - 40, r.bottom - button.offsetHeight - 12)}px`;
    requestAnimationFrame(place);
  };
  requestAnimationFrame(place);
}

function openDialog(onInsert: (html: string, text: string) => void): void {
  if (document.getElementById('yungle-dialog')) return;
  const host = document.createElement('div');
  host.id = 'yungle-dialog';
  // A shadow root keeps the page's CSS off the frame's box, and ours off the page.
  const shadow = host.attachShadow({ mode: 'closed' });
  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(15, 23, 20, .35)',
    zIndex: '2147483646',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } satisfies Partial<CSSStyleDeclaration>);
  const frame = document.createElement('iframe');
  frame.src = browser.runtime.getURL('/compose.html');
  frame.title = 'Send with Yungle';
  Object.assign(frame.style, {
    width: '400px',
    height: '560px',
    maxHeight: '90vh',
    border: '0',
    borderRadius: '16px',
    background: 'transparent',
    boxShadow: '0 24px 60px rgba(0,0,0,.3)',
  } satisfies Partial<CSSStyleDeclaration>);
  backdrop.appendChild(frame);
  shadow.appendChild(backdrop);
  document.body.appendChild(host);

  const extOrigin = new URL(browser.runtime.getURL('/')).origin;
  const close = () => {
    window.removeEventListener('message', onMessage);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
  };
  const onMessage = (e: MessageEvent) => {
    // Only our own frame, from our own origin.
    if (e.source !== frame.contentWindow || e.origin !== extOrigin || !isComposeMessage(e.data)) return;
    if (e.data.type === 'insert') {
      onInsert(e.data.html, e.data.text);
      setTimeout(close, 900);
    } else close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('message', onMessage);
  document.addEventListener('keydown', onKey, true);
  // A click on the backdrop closes it — but never mid-upload by accident: the
  // frame covers its own area, so only the dimmed margin counts.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && confirmLeave()) close();
  });
}

function confirmLeave(): boolean {
  // The dialog cannot tell us whether an upload is running without another
  // message round; asking is cheaper than losing a 5 GB upload to a stray click.
  return window.confirm('Close Yungle? An upload in progress will stop.');
}

/**
 * Put the link where the caret was. `execCommand` is deprecated but it is the
 * one insertion both editors treat as typing — undo works, and their own state
 * (drafts, autosave) sees the change. A plain DOM insert is the fallback.
 */
export function insert(editor: HTMLElement, saved: Range | null, html: string, text: string): void {
  editor.focus();
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    if (saved) sel.addRange(saved);
    else {
      const end = document.createRange();
      end.selectNodeContents(editor);
      end.collapse(false);
      sel.addRange(end);
    }
  }
  const ok = html ? document.execCommand('insertHTML', false, `${html}<br>`) : document.execCommand('insertText', false, `${text} `);
  if (ok) return;
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
  const node = html ? range?.createContextualFragment(html) : document.createTextNode(`${text} `);
  if (range && node) {
    range.insertNode(node);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  } else {
    editor.append(html ? document.createRange().createContextualFragment(html) : text);
  }
}

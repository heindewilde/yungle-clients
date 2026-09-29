// Inlined as a data URL: the content script runs in Gmail's page, and a file
// URL would have to be exposed to those sites as a web-accessible resource.
import mark from '@/assets/mark.png?inline';
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
const floatBg = 'rgba(255, 255, 255, 0.92)';

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
  // Quiet on purpose: a small "y" in the toolbar's own grey, like Gmail's
  // attach and Drive icons, that turns Yungle green on hover. It is there when
  // needed without competing with Send on every email.
  const button = document.createElement('button');
  button.type = 'button';
  button.title = 'Send big files with Yungle';
  button.setAttribute('aria-label', 'Send big files with Yungle');
  // The glyph is a mask filled with `currentColor`, so one image serves any
  // colour — including a dark Gmail or Outlook theme.
  const glyph = document.createElement('span');
  Object.assign(glyph.style, {
    display: 'block',
    width: '18px',
    height: '18px',
    backgroundColor: 'currentColor',
    maskImage: `url("${mark}")`,
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    webkitMaskImage: `url("${mark}")`,
    webkitMaskSize: 'contain',
    webkitMaskRepeat: 'no-repeat',
    webkitMaskPosition: 'center',
  } satisfies Partial<CSSStyleDeclaration>);
  button.appendChild(glyph);
  // The editor's text colour tells us the theme; dimmed, it matches the icons.
  const rest = getComputedStyle(editor).color || '#5f6368';
  Object.assign(button.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    padding: '0',
    margin: '0 4px',
    border: '0',
    borderRadius: '50%',
    background: 'transparent',
    color: rest,
    opacity: '0.7',
    cursor: 'pointer',
    verticalAlign: 'middle',
    transition: 'color .15s, background-color .15s, opacity .15s',
  } satisfies Partial<CSSStyleDeclaration>);
  const lit = (on: boolean) => {
    button.style.color = on ? '#3ea76a' : rest;
    button.style.opacity = on ? '1' : '0.7';
    button.style.backgroundColor = on ? 'rgba(127, 127, 127, 0.14)' : button.dataset.float ? floatBg : 'transparent';
  };
  button.addEventListener('mouseenter', () => lit(true));
  button.addEventListener('mouseleave', () => lit(false));
  button.addEventListener('focus', () => lit(true));
  button.addEventListener('blur', () => lit(false));

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
  // Fallback: float on the editor's bottom-right corner, following it. Over
  // text an icon needs its own small surface to stay legible.
  button.dataset.float = '1';
  Object.assign(button.style, {
    position: 'fixed',
    zIndex: '2147483000',
    background: floatBg,
    boxShadow: '0 1px 4px rgba(0,0,0,.2)',
  } satisfies Partial<CSSStyleDeclaration>);
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
 * (drafts, autosave) sees the change. A plain-text node is the fallback.
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
  // The editor refused. Fall back to the plain line as a text node — never
  // parse HTML into someone else's page by hand.
  const node = document.createTextNode(`${text} `);
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
  if (range) range.insertNode(node);
  else editor.append(node);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

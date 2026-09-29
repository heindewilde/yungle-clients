/**
 * Finding compose windows in Gmail and Outlook on the web.
 *
 * This is the part that breaks when they change their markup, so it is kept
 * small, pure (a root in, elements out) and tested against saved fixtures.
 * Every selector prefers what is structural or accessibility-facing over
 * generated class names, and each adapter has ONE fallback: if no toolbar can
 * be found, the button floats at the editor's corner instead. A compose with
 * no findable editor gets no button at all — never a broken one.
 */

export interface ComposeTarget {
  /** Where the link is inserted. */
  editor: HTMLElement;
  /** Where the button goes; null means "float it on the editor". */
  toolbar: HTMLElement | null;
}

export interface Adapter {
  name: 'gmail' | 'outlook';
  find(root: ParentNode): ComposeTarget[];
}

/** Editors too small to be a message body (a subject line, a search box). */
function bigEnough(el: HTMLElement): boolean {
  // jsdom has no layout; treat unknown size as big enough so fixtures test the selectors.
  const r = el.getBoundingClientRect();
  return (r.width === 0 && r.height === 0) || (r.width >= 200 && r.height >= 40);
}

export const gmail: Adapter = {
  name: 'gmail',
  find(root) {
    // `g_editable` has marked Gmail's rich-text body for over a decade.
    const editors = [...root.querySelectorAll<HTMLElement>('div[g_editable="true"][contenteditable="true"]')];
    return editors.filter(bigEnough).map((editor) => {
      // The compose's bottom bar is the row holding the Send button. Walk up
      // to the nearest container that has one, so pop-out, inline reply and
      // full-screen composes all resolve to their own bar.
      let node: HTMLElement | null = editor;
      let toolbar: HTMLElement | null = null;
      for (let i = 0; node && i < 25 && !toolbar; i++) {
        toolbar = node.querySelector<HTMLElement>('tr.btC');
        node = node.parentElement;
      }
      return { editor, toolbar };
    });
  },
};

export const outlook: Adapter = {
  name: 'outlook',
  find(root) {
    // The body editor is a contenteditable textbox that is multi-line; the
    // subject and recipient boxes are not contenteditable divs of this shape.
    const editors = [
      ...root.querySelectorAll<HTMLElement>('div[contenteditable="true"][role="textbox"]'),
    ].filter((el) => el.getAttribute('aria-multiline') !== 'false' && bigEnough(el));
    return editors.map((editor) => {
      let node: HTMLElement | null = editor;
      let toolbar: HTMLElement | null = null;
      for (let i = 0; node && i < 25 && !toolbar; i++) {
        // The Send button's own group. `ComposeSendButton` is Outlook's test id.
        const send = node.querySelector<HTMLElement>('[data-testid="ComposeSendButton"], button[aria-label^="Send"]');
        toolbar = send?.parentElement ?? null;
        node = node.parentElement;
      }
      return { editor, toolbar };
    });
  },
};

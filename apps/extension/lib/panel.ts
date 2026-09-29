/**
 * Opening the side panel (Chrome) or sidebar (Firefox) from the popup.
 *
 * Both browsers only allow it inside a user gesture, and an `await` before the
 * call can lose the gesture — so the window id is looked up when the popup
 * opens (`rememberWindow`), and `openPanel` makes the call synchronously.
 */

export type PanelView = 'send' | 'settings';

let windowId: number | undefined;

export function rememberWindow(): void {
  void browser.windows.getCurrent().then((w) => (windowId = w.id));
}

export function openPanel(view: PanelView): void {
  void browser.storage.session.set({ panelView: view });
  const b = browser as unknown as {
    sidePanel?: { open(o: { windowId: number }): Promise<void> };
    sidebarAction?: { open(): Promise<void> };
  };
  if (b.sidePanel && windowId !== undefined) void b.sidePanel.open({ windowId });
  else void b.sidebarAction?.open();
  window.close();
}

export async function readPanelView(): Promise<PanelView> {
  const got = await browser.storage.session.get('panelView');
  return got.panelView === 'settings' ? 'settings' : 'send';
}

export function onPanelView(listener: (v: PanelView) => void): () => void {
  const handler = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'session' && changes.panelView) listener(changes.panelView.newValue === 'settings' ? 'settings' : 'send');
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}

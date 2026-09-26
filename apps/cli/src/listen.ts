import { createHmac } from 'node:crypto';
import { YungleApiError, type YungleClient, type WebhookEventType } from 'yungle-client';

/**
 * `yungle webhooks listen` — see events as they happen, and optionally forward
 * them to a server on this machine while you build the receiver.
 *
 * It reads a pull endpoint of its own (no public URL needed), so it works from
 * a laptop behind any NAT. The endpoint is found by its description and reused,
 * and its secret is rotated at start, because the secret is only ever shown at
 * creation and forwarding needs one to sign with.
 */

export const LISTEN_DESCRIPTION = 'yungle webhooks listen';
const ALL: WebhookEventType[] = [
  'transfer.ready',
  'transfer.downloaded',
  'transfer.expiring',
  'transfer.expired',
  'collection.file_uploaded',
];

export function signForForward(secret: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export async function ensureListenEndpoint(api: YungleClient): Promise<{ id: string; secret: string }> {
  const { webhooks } = await api.listWebhooks();
  const existing = webhooks.find((w) => w.mode === 'pull' && w.description === LISTEN_DESCRIPTION);
  if (existing) {
    if (!existing.enabled) await api.updateWebhook(existing.id, { enabled: true });
    const { secret } = await api.rotateWebhookSecret(existing.id);
    return { id: existing.id, secret };
  }
  try {
    const { webhook, secret } = await api.createWebhook({ url: null, events: ALL, description: LISTEN_DESCRIPTION });
    return { id: webhook.id, secret };
  } catch (err) {
    // Collection events are paid; a free workspace listens to the transfer ones.
    if (err instanceof YungleApiError && err.code === 'upgrade_required' && /collection/.test(err.message)) {
      const { webhook, secret } = await api.createWebhook({
        url: null,
        events: ALL.filter((e) => e.startsWith('transfer.')),
        description: LISTEN_DESCRIPTION,
      });
      return { id: webhook.id, secret };
    }
    if (err instanceof YungleApiError && err.code === 'upgrade_required') {
      throw new Error(
        'The free plan includes one webhook endpoint and this workspace already has one. ' +
          'Remove it in Settings → Webhooks to listen here, or upgrade for more.',
      );
    }
    throw err;
  }
}

/** Skip the backlog: walk to the newest event and return the cursor after it. */
export async function cursorAtNow(api: YungleClient, id: string): Promise<string | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await api.listWebhookEvents(id, { limit: 500, cursor });
    cursor = page.nextCursor ?? cursor;
    if (!page.hasMore) return cursor;
  }
}

export function describeEvent(e: { type: string; data: Record<string, unknown> }): string {
  const d = e.data as {
    transfer?: { id: string; title?: string | null };
    download?: { recipient?: string | null };
    collection?: { title?: string };
    file?: { name?: string };
    reason?: string;
  };
  if (d.file) return `${d.file.name} → ${d.collection?.title ?? 'collection'}`;
  const what = d.transfer?.title || d.transfer?.id || '';
  if (d.download) return `${what}${d.download.recipient ? ` by ${d.download.recipient}` : ''}`;
  return d.reason ? `${what} (${d.reason})` : what;
}

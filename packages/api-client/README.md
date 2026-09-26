# yungle-client

Typed client for the [Yungle](https://yungle.co) API — a private, EU-hosted file
transfer service. Send transfers, build client collections and sync contacts
from Node.

```bash
npm install yungle-client
```

```ts
import { YungleClient } from 'yungle-client';

const yungle = new YungleClient({ apiKey: process.env.YUNGLE_API_KEY! });

// Everything here works on the free plan.
const { transfers } = await yungle.listTransfers();
const { downloads } = await yungle.transferDownloads(transfers[0].id);

// Sending works on the free plan too; collections need a paid one.
const draft = await yungle.createTransfer({
  files: [{ name: 'final-cut.mov', size: 8_123_456_789 }],
});
// …stream the bytes to draft.tusEndpoint using draft.files[n].uploadToken…
await yungle.finalizeTransfer(draft.transfer.id, { recipients: ['client@example.com'] });
```

Get a key from Settings → API keys. Every account can use the API: transfers and contacts on the free plan,
collections on a paid one. The first 10 GB of API uploads each month are free.

## What it does and doesn't do

- **Dependency-free**, built on `fetch`, so it runs unchanged on Node 22+, Bun,
  Deno and edge runtimes.
- **Retries are safe.** Throttles are always retried; 5xx and dropped connections are retried
  for GET, DELETE and POST. Every POST carries an `Idempotency-Key`, reused on each retry, so a
  lost response to `createTransfer` gets the first draft back instead of making a second.
- **Pages are walked for you.** Lists take `{ limit, cursor }` and return `nextCursor`;
  `allTransfers()` and `allCollectionFiles(id)` are async iterators over everything.
- **Does not upload bytes.** Endpoints that accept files return a tus endpoint
  and per-file tokens; streaming to those is the caller's job. Keeping the byte
  pipeline out is what lets this stay one small file. If you want that handled
  for you, use [`yungle-cli`](https://www.npmjs.com/package/yungle-cli), which
  does it resumably.
- **Errors carry a stable `code`.** Branch on `err.code`, never on the message.

```ts
import { YungleApiError } from 'yungle-client';

try {
  await yungle.createCollection({ title: 'Client deliveries' });
} catch (err) {
  if (err instanceof YungleApiError && err.code === 'upgrade_required') {
    // A free account wrote to a collection; collections come with a plan.
  }
}
```

## Webhooks

```ts
import { verifyWebhook } from 'yungle-client';

const { secret } = await yungle.createWebhook({ url: 'https://example.com/hooks/yungle', events: ['transfer.downloaded'] });
// The secret is returned once. In your handler, with the RAW request body:
if (!(await verifyWebhook(rawBody, req.headers['yungle-signature'], secret))) return res.status(400).end();
```

Signed with HMAC-SHA256 over a timestamp and the body; stale signatures (over 5 minutes) are
refused. No public URL? Create the endpoint with `url: null` and poll `listWebhookEvents(id, { cursor })` instead.

## Not reachable

Your vault and end-to-end encrypted transfers, because their keys are derived in
the client and never sent to Yungle. See
<https://yungle.co/developers/unsupported>.

## Related

- [`yungle-cli`](https://www.npmjs.com/package/yungle-cli) — resumable uploads from your terminal
- [`yungle-mcp`](https://www.npmjs.com/package/yungle-mcp) — connect Claude or Cursor to Yungle
- [API reference](https://yungle.co/developers/reference?ref=npm) · [OpenAPI spec](https://yungle.co/api/v1/openapi.json)

MIT

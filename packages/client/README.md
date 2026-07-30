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

// Reading is free on any account.
const { transfers } = await yungle.listTransfers();
const { downloads } = await yungle.transferDownloads(transfers[0].id);

// Sending needs a paid plan.
const draft = await yungle.createTransfer({
  files: [{ name: 'final-cut.mov', size: 8_123_456_789 }],
});
// …stream the bytes to draft.tusEndpoint using draft.files[n].uploadToken…
await yungle.finalizeTransfer(draft.transfer.id, { recipients: ['client@example.com'] });
```

Get a key from Settings → API keys. Reads are free; creating, sending and
uploading come with a paid plan.

## What it does and doesn't do

- **Dependency-free**, built on `fetch`, so it runs unchanged on Node 22+, Bun,
  Deno and edge runtimes.
- **Retries what is safe to retry** — throttles always, and 5xx only on
  idempotent operations. `createTransfer` is never retried automatically,
  because repeating it would make a second draft.
- **Does not upload bytes.** Endpoints that accept files return a tus endpoint
  and per-file tokens; streaming to those is the caller's job. Keeping the byte
  pipeline out is what lets this stay one small file. If you want that handled
  for you, use [`yungle-cli`](https://www.npmjs.com/package/yungle-cli), which
  does it resumably.
- **Errors carry a stable `code`.** Branch on `err.code`, never on the message.

```ts
import { YungleApiError } from 'yungle-client';

try {
  await yungle.createTransfer({ files });
} catch (err) {
  if (err instanceof YungleApiError && err.code === 'upgrade_required') {
    // Reads are free; this is a write.
  }
}
```

## Not reachable

Your vault and end-to-end encrypted transfers, because their keys are derived in
the client and never sent to Yungle. See
<https://yungle.co/developers/unsupported>.

## Related

- [`yungle-cli`](https://www.npmjs.com/package/yungle-cli) — resumable uploads from your terminal
- [`yungle-mcp`](https://www.npmjs.com/package/yungle-mcp) — read your transfers from an AI assistant
- [Full API reference](https://yungle.co/developers) · [OpenAPI spec](https://yungle.co/api/v1/openapi.json)

MIT

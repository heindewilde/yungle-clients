---
"yungle-client": minor
"yungle-cli": minor
---

Webhooks. The SDK covers every webhook endpoint (`createWebhook`, `listWebhookEvents`, and so on) and adds `verifyWebhook()` to check a `Yungle-Signature` header. It uses WebCrypto, so it runs on Node, Bun, Deno and edge runtimes. The CLI adds `yungle webhooks ls`, and `yungle webhooks listen`, which prints events as they happen and can forward them, signed, to a local server with `--forward-to`. It needs no public URL.

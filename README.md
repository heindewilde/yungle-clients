# Yungle clients

Client libraries for [Yungle](https://yungle.co) — a private, EU-hosted file
transfer service, and an alternative to WeTransfer for people whose files need
to stay in Europe.

| Package | | |
|---|---|---|
| [`yungle-cli`](https://www.npmjs.com/package/yungle-cli) | `npm i -g yungle-cli` | Send and sync files from your terminal, resumably |
| [`yungle-mcp`](https://www.npmjs.com/package/yungle-mcp) | `npx -y yungle-mcp` | Read your transfers from an AI assistant (MCP) |
| [`yungle-client`](https://www.npmjs.com/package/yungle-client) | `npm i yungle-client` | Typed SDK for the API |

Reading is free on any Yungle account. Creating, sending and uploading come with
a paid plan. Get a key from Settings → API keys.

- **API reference:** <https://yungle.co/developers>
- **OpenAPI 3.1 spec:** <https://yungle.co/api/v1/openapi.json>

## Why a CLI

Yungle's upload engine is resumable at part granularity and sized for 100 GB
transfers. A browser tab has to stay open for the whole upload, and a closed
laptop lid costs you the file. `yungle send` does not: interrupt it, run the same
command again, and it continues from the last committed part.

## What these cannot do

Your vault and end-to-end encrypted transfers are not reachable, and cannot be —
their keys are derived in the client and never sent to Yungle. The MCP server
additionally has no tool that sends, deletes, invites or revokes; it reads
metadata only, by design. See
<https://yungle.co/developers/unsupported>.

## Development

```bash
pnpm install
pnpm -r test
pnpm -r build
```

The Yungle server itself is not open source; this repository holds only the
clients. Issues and pull requests about the clients are welcome here.

MIT

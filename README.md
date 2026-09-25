# Yungle clients

Client libraries for [Yungle](https://yungle.co?ref=github): private, EU-hosted
file transfer. It's an alternative to WeTransfer for files that need to stay in Europe.

| Package | Install | |
|---|---|---|
| [`yungle-cli`](apps/cli) | `npm i -g yungle-cli` | Send and sync files from your terminal or CI, resumably |
| [`yungle-mcp`](packages/mcp-server) | `npx -y yungle-mcp` | Let an AI assistant (Claude, Cursor, Windsurf) read your transfers |
| [`yungle-client`](packages/api-client) | `npm i yungle-client` | Typed, dependency-free SDK for the API |

Every account can use the API: transfers and contacts work on the free plan, and
collections need a paid one. The first 10 GB of API uploads each month are free.
Create a key under Settings → API keys.

- **Docs:** <https://yungle.co/developers?ref=github>
- **OpenAPI 3.1:** <https://yungle.co/api/v1/openapi.json>
- **For LLMs:** <https://yungle.co/llms.txt>

```bash
npm i -g yungle-cli
yungle auth login
yungle send ./render.mov --to client@example.com
```

## Why a CLI

Yungle's upload engine resumes at part granularity and handles transfers up to
100 GB. A browser tab has to stay open for the whole upload, and closing the laptop
lid loses the file. `yungle send` doesn't have that problem: interrupt it, run the same command again,
and it continues from the last committed part.

## What these cannot do

Your vault and end-to-end encrypted transfers can't be reached, because their keys are
derived in your client and never sent to Yungle. The MCP server has no tool that
sends, deletes, invites or revokes. See
<https://yungle.co/developers/unsupported>.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm contract   # the SDK against the live OpenAPI spec
```

This repository is where the clients are developed. The Yungle server is not
open source. See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT

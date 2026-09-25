# Contributing

Issues and pull requests about the CLI, the MCP server and the SDK are welcome.
Questions about your account or a transfer go to hello@yungle.co instead.
Security issues go through <https://yungle.co/.well-known/security.txt>.

## Making a change

1. `pnpm install`, then make the change with a test next to it (`src/*.test.ts`,
   `node:test`).
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
3. If a published package changes, run `pnpm changeset` and write the entry for
   the people who use it.

Merging to `main` opens a release PR. Merging that PR publishes to npm with
provenance and updates the MCP registry listing.

## Ground rules

- **No new runtime dependencies without a reason.** The CLI's argument parser is
  hand-rolled because a framework would outweigh the tool.
- **The MCP server never gains a tool that deletes, revokes or invites.** A
  model can be steered by text inside the data it reads, like a filename.
- **`yungle-client` stays dependency-free** and runs anywhere `fetch` exists.

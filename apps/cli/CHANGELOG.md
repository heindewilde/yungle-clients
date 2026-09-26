# yungle-cli

## 0.2.0

### Minor Changes

- [#2](https://github.com/heindewilde/yungle-clients/pull/2) [`a33a27a`](https://github.com/heindewilde/yungle-clients/commit/a33a27a02a51b1f81c746990bfa9541854d4d9ac) Thanks [@heindewilde](https://github.com/heindewilde)! - A redesigned CLI.

  - **Output** is calmer and clearer: a progress bar with speed and time left, tidy tables that fit your terminal, and results that finish with the next useful command. When piped it prints just the link, and `--json` still prints JSON.
  - **Guided mode.** Run `yungle` on its own for a menu. Leave the paths off `yungle send`, or the link off `yungle get`, and it asks. It never prompts in scripts, in CI, or with `--json`/`--yes`.
  - **Errors** say what happened and which command fixes it. Typos get a "did you mean" suggestion.
  - **New commands:**
    - `yungle status` shows who opened and downloaded a transfer.
    - `yungle open` opens the dashboard, a transfer, or your keys, plan or webhooks.
    - `yungle watch <dir> --collection <id>` keeps uploading new files once they stop changing.
    - `yungle completion zsh|bash|fish` sets up tab completion.
    - `yungle whoami` shows who you're signed in as.
    - `yungle transfers`, `collections` and `contacts` list what you have.
    - `yungle revoke` stops a transfer's link.
  - **Names:** commands accept the short ID from `yungle transfers` or a transfer's link. `yungle login --key` saves an API key. The old spellings (`auth login`, `ls transfers`, `rm transfer`) still work.
  - **MCP:** `yungle mcp install` explains that the local server needs an API key, because a browser sign-in expires within the hour.
  - **Emailing:** a browser sign-in makes links but never emails anyone. `yungle send --to` now checks this before uploading: at a terminal it offers to send a link instead, and in a script it stops before any bytes move. Use `yungle login --key` to email recipients.

- [#2](https://github.com/heindewilde/yungle-clients/pull/2) [`0112d76`](https://github.com/heindewilde/yungle-clients/commit/0112d761e1b877d8cd1d106a6c574627a9e9a22c) Thanks [@heindewilde](https://github.com/heindewilde)! - `yungle login` signs you in from the browser; there's no key to copy, and it works over SSH. The session refreshes itself, including during long uploads. `yungle logout` revokes it. The MCP server gains `create_share_link`, which shares content you pass it as a link without emailing anyone, and `share_local_files`, which does the same for files on disk (local server only; hidden files are refused). It also gains `send_transfer`, which only exists when the credential may send email; every send asks the user to confirm, and a client that can't ask gets the link instead. `yungle mcp install --allow-write` accepts a key with `transfers:write`. The MCP package now exports `createServer` for running it over HTTP. `yungle-client` reports `via` and `canEmail` on `me().key`.

- [`a39b31f`](https://github.com/heindewilde/yungle-clients/commit/a39b31f3e5686d452f6052995a101bffede77275) Thanks [@heindewilde](https://github.com/heindewilde)! - Each client now identifies itself as `yungle-cli/<version>`, `yungle-mcp/<version>` or `yungle-client/<version>` in `User-Agent`. `yungle-client` accepts a `userAgent` option. The CLI has `yungle --version`. The MCP server reports its real version during the handshake; before this it always said 0.1.0.

- [#2](https://github.com/heindewilde/yungle-clients/pull/2) [`c74e5ab`](https://github.com/heindewilde/yungle-clients/commit/c74e5ab613ae83e1224bff7d14e05a69cc3b9c4b) Thanks [@heindewilde](https://github.com/heindewilde)! - Webhooks. The SDK covers every webhook endpoint (`createWebhook`, `listWebhookEvents`, and so on) and adds `verifyWebhook()` to check a `Yungle-Signature` header. It uses WebCrypto, so it runs on Node, Bun, Deno and edge runtimes. The CLI adds `yungle webhooks ls`, and `yungle webhooks listen`, which prints events as they happen and can forward them, signed, to a local server with `--forward-to`. It needs no public URL.

- [#2](https://github.com/heindewilde/yungle-clients/pull/2) [`16b6600`](https://github.com/heindewilde/yungle-clients/commit/16b6600fa1896bcc8da29ef5e87b3d4120a043b6) Thanks [@heindewilde](https://github.com/heindewilde)! - New command, `yungle get <link>`, downloads a transfer someone sent you. It needs no API key, prompts for a password when the transfer has one, resumes an interrupted download, and can fetch everything as one zip with `--zip`. It can't open end-to-end encrypted transfers yet; for those, use a browser.

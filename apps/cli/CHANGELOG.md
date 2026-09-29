# yungle-cli

## 0.3.0

### Minor Changes

- [`dd711cd`](https://github.com/heindewilde/yungle-clients/commit/dd711cd2fd31c62013171bf7a9fc54a10b04ca7f) Thanks [@heindewilde](https://github.com/heindewilde)! - For agents and scripts that move big files. `yungle-client` gains `uploadFile` (and `client.uploadFile`): a zero-dependency resumable tus upload from any `Blob` — in Node, `fs.openAsBlob(path)` — retried after drops and renewing its token as it runs. The MCP server's local uploads use it, so `share_local_files` now survives a dropped connection, takes folders (keeping their structure), and reports progress. `create_transfer` returns one keyless upload command per file (`npx -y yungle-cli put <file> --target …`), so an assistant with a shell can move files its connection cannot carry, and `finalize_transfer` turns the draft into a link. The new `yungle put` runs those commands. Downloads (`yungle get`/`pull`, the MCP `download_files`, Python `download`) now verify each file against the server's CRC-32 and delete a damaged copy.

- [`cca8096`](https://github.com/heindewilde/yungle-clients/commit/cca809626b63b818abe0b66882e8f118a7b54605) Thanks [@heindewilde](https://github.com/heindewilde)! - Getting files out. `yungle-client` adds `transferDownloadLinks`, `collectionDownloadLinks` and `resolveLink` (signed, resumable download URLs for your own transfers and collections, or for a link someone shared). `yungle get` now takes collection links too and keeps folder structure; the new `yungle pull --collection <id>` downloads your own collection and, run again, fetches only what is new. The MCP server gains `get_download_links` (every credential, hosted included) and, when running locally, `download_files`, which saves into a new subfolder of a folder you name. JSON errors from `yungle get` now carry the server's code (`guests_only`, `password_required`, …), and a cancelled prompt exits 130 as documented.

- [`15812fd`](https://github.com/heindewilde/yungle-clients/commit/15812fd92e45d81265d23e58492652c5cf7af04e) Thanks [@heindewilde](https://github.com/heindewilde)! - Upload requests. `yungle-client` adds `listRequests`, `createRequest`, `getRequest` and `setRequestStatus` (public pages that let other people upload into one of your collections), the `request.submitted` webhook type, and `crc32` on transfer and collection files. `yungle requests` lists them; `yungle requests new --collection <id> --title …` makes one and prints its link; `pause`, `resume`, `close` and `show` manage them. The MCP server can read them (`list_upload_requests`, `get_upload_request`) but not create them: a public upload page is a door into someone's storage, and a model can be steered.

- [`ca44e4f`](https://github.com/heindewilde/yungle-clients/commit/ca44e4fcb990624ab2131844bea49e8bd84b6031) Thanks [@heindewilde](https://github.com/heindewilde)! - Uploads can now run longer than two hours. Upload tokens last two hours and every tus request presents one, so a long upload used to fail at its first request after that, and could never resume after a drop past the two-hour mark. `yungle-client` adds `createTokenKeeper`, `renewUploadToken` and `client.renewUploadToken()` (backed by `POST /api/uploads/token`), and types the new `uploadTokenExpiresAt`. `yungle send`, `push` and `watch` renew automatically and save each renewed token, so a run killed after hours still resumes.

- [`f1686e3`](https://github.com/heindewilde/yungle-clients/commit/f1686e38785db27c6c2e0b5f1a5142ccf713136e) Thanks [@heindewilde](https://github.com/heindewilde)! - Files from URLs. `createTransfer`, `addTransferFiles` and `addCollectionFiles` accept `imports: [{ url, name?, path? }]` — Yungle fetches each file itself, so a presigned S3 link or a CDN URL of any size moves without passing through you — and `getImport` / `waitForImports` follow them. `yungle send` and `yungle push` take `--from-url <url>` (repeatable) and wait for the fetch before sending. The MCP server gains `share_from_urls` and `get_import_status`, which is what lets the hosted connector move big files at all. Also fixed: a repeated `--to` kept only the last address; every one is now kept.

## 0.2.1

### Patch Changes

- [`4b48867`](https://github.com/heindewilde/yungle-clients/commit/4b488674b688596cedd74f254258d45b1f80fe96) Thanks [@heindewilde](https://github.com/heindewilde)! - Yungle no longer records whether a recipient opened a transfer page — only whether they downloaded it. `yungle status` and the MCP `get_transfer` description no longer mention opens, and `RecipientStatus.opened` is deprecated (the API now always returns `false`).

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

# yungle-mcp

## 0.2.2

### Patch Changes

- [`7a3bef5`](https://github.com/heindewilde/yungle-clients/commit/7a3bef5a8c183bc390cf435fa36d41c192063f1e) Thanks [@heindewilde](https://github.com/heindewilde)! - Without `YUNGLE_API_KEY` the server now starts and lists its read tools instead of exiting, so directories and inspectors can see what it offers. Every call explains that a key is missing; nothing can be read, shared or sent without one.

## 0.2.1

### Patch Changes

- [`7634870`](https://github.com/heindewilde/yungle-clients/commit/76348703973b838b1ed39b76314a6fa0240d9c2b) Thanks [@heindewilde](https://github.com/heindewilde)! - Every tool now repeats its human-readable title in `annotations.title`, where the Claude connector directory and some MCP hosts look for it.

## 0.2.0

### Minor Changes

- [#2](https://github.com/heindewilde/yungle-clients/pull/2) [`0112d76`](https://github.com/heindewilde/yungle-clients/commit/0112d761e1b877d8cd1d106a6c574627a9e9a22c) Thanks [@heindewilde](https://github.com/heindewilde)! - `yungle login` signs you in from the browser; there's no key to copy, and it works over SSH. The session refreshes itself, including during long uploads. `yungle logout` revokes it. The MCP server gains `create_share_link`, which shares content you pass it as a link without emailing anyone, and `share_local_files`, which does the same for files on disk (local server only; hidden files are refused). It also gains `send_transfer`, which only exists when the credential may send email; every send asks the user to confirm, and a client that can't ask gets the link instead. `yungle mcp install --allow-write` accepts a key with `transfers:write`. The MCP package now exports `createServer` for running it over HTTP. `yungle-client` reports `via` and `canEmail` on `me().key`.

- [`a39b31f`](https://github.com/heindewilde/yungle-clients/commit/a39b31f3e5686d452f6052995a101bffede77275) Thanks [@heindewilde](https://github.com/heindewilde)! - Each client now identifies itself as `yungle-cli/<version>`, `yungle-mcp/<version>` or `yungle-client/<version>` in `User-Agent`. `yungle-client` accepts a `userAgent` option. The CLI has `yungle --version`. The MCP server reports its real version during the handshake; before this it always said 0.1.0.

### Patch Changes

- Updated dependencies [[`0112d76`](https://github.com/heindewilde/yungle-clients/commit/0112d761e1b877d8cd1d106a6c574627a9e9a22c), [`c9cfd78`](https://github.com/heindewilde/yungle-clients/commit/c9cfd78dafc202ce1c963b7ea9032b9f40a2051e), [`a39b31f`](https://github.com/heindewilde/yungle-clients/commit/a39b31f3e5686d452f6052995a101bffede77275), [`c74e5ab`](https://github.com/heindewilde/yungle-clients/commit/c74e5ab613ae83e1224bff7d14e05a69cc3b9c4b)]:
  - yungle-client@0.2.0

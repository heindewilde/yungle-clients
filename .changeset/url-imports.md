---
"yungle-client": minor
"yungle-cli": minor
"yungle-mcp": minor
---

Files from URLs. `createTransfer`, `addTransferFiles` and `addCollectionFiles` accept `imports: [{ url, name?, path? }]` — Yungle fetches each file itself, so a presigned S3 link or a CDN URL of any size moves without passing through you — and `getImport` / `waitForImports` follow them. `yungle send` and `yungle push` take `--from-url <url>` (repeatable) and wait for the fetch before sending. The MCP server gains `share_from_urls` and `get_import_status`, which is what lets the hosted connector move big files at all. Also fixed: a repeated `--to` kept only the last address; every one is now kept.

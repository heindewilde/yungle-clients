---
"yungle-client": minor
"yungle-cli": minor
"yungle-mcp": minor
---

For agents and scripts that move big files. `yungle-client` gains `uploadFile` (and `client.uploadFile`): a zero-dependency resumable tus upload from any `Blob` — in Node, `fs.openAsBlob(path)` — retried after drops and renewing its token as it runs. The MCP server's local uploads use it, so `share_local_files` now survives a dropped connection, takes folders (keeping their structure), and reports progress. `create_transfer` returns one keyless upload command per file (`npx -y yungle-cli put <file> --target …`), so an assistant with a shell can move files its connection cannot carry, and `finalize_transfer` turns the draft into a link. The new `yungle put` runs those commands. Downloads (`yungle get`/`pull`, the MCP `download_files`, Python `download`) now verify each file against the server's CRC-32 and delete a damaged copy.

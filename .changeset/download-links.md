---
"yungle-client": minor
"yungle-cli": minor
"yungle-mcp": minor
---

Getting files out. `yungle-client` adds `transferDownloadLinks`, `collectionDownloadLinks` and `resolveLink` (signed, resumable download URLs for your own transfers and collections, or for a link someone shared). `yungle get` now takes collection links too and keeps folder structure; the new `yungle pull --collection <id>` downloads your own collection and, run again, fetches only what is new. The MCP server gains `get_download_links` (every credential, hosted included) and, when running locally, `download_files`, which saves into a new subfolder of a folder you name. JSON errors from `yungle get` now carry the server's code (`guests_only`, `password_required`, …), and a cancelled prompt exits 130 as documented.

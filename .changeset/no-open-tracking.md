---
"yungle-cli": patch
"yungle-client": patch
"yungle-mcp": patch
---

Yungle no longer records whether a recipient opened a transfer page — only whether they downloaded it. `yungle status` and the MCP `get_transfer` description no longer mention opens, and `RecipientStatus.opened` is deprecated (the API now always returns `false`).

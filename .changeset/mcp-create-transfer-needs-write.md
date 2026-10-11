---
"yungle-mcp": patch
---

`create_transfer` is listed only for a credential with `transfers:write`. A read-only key used to get it too, and the API refuses to create a transfer without that scope, so the tool could only fail.

---
"yungle-mcp": patch
---

Without `YUNGLE_API_KEY` the server now starts and lists its read tools instead of exiting, so directories and inspectors can see what it offers. Every call explains that a key is missing; nothing can be read, shared or sent without one.

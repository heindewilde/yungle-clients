---
"yungle-client": patch
---

A dropped connection is now retried for GET, DELETE and POST (with the same `Idempotency-Key`), as the README always said; before, the network error was thrown straight away. A caller's own abort is never retried. Docs links point to docs.yungle.co.

---
"yungle-client": minor
---

`listTransfers` and `listCollectionFiles` take `{ limit, cursor }` and return `nextCursor`. `allTransfers()` and `allCollectionFiles()` walk every page for you. Every POST now sends an `Idempotency-Key` and reuses it when retrying, so a create request that fails with a 5xx or a dropped connection is retried without making a second copy.

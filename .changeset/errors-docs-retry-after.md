---
"yungle-client": minor
---

Errors now carry `docs`, a link to the explanation of their `code`, and `retryAfterSeconds` also reads the `Retry-After` header when the body states no wait. Before this, the monthly-allowance 429 (which sends `Retry-After: 3600` and no `details.retryAfterSeconds`) was retried after half a second instead of an hour. `parseRetryAfter` is exported. Timestamps the API always sends (`createdAt`, `updatedAt`, a transfer's `expiresAt`) are no longer typed as nullable, and pulled webhook events have a named type, `PulledWebhookEvent`.

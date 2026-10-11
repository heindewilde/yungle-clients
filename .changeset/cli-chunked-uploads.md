---
"yungle-cli": patch
---

Uploads send one part per request instead of the whole file in one, so a large file on a slow connection is no longer cut off by the server's 30-minute request limit. Help and docs links point to docs.yungle.co.

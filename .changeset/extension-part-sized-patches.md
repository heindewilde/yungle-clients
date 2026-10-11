---
"yungle-extension": patch
---

Plain (non-encrypted) uploads now send one server part per request instead of the whole file in one, so a large file on a slow connection is no longer cut off by the server's 30-minute limit on a single request.

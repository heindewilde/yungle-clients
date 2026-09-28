---
"yungle-client": minor
"yungle-cli": minor
---

Uploads can now run longer than two hours. Upload tokens last two hours and every tus request presents one, so a long upload used to fail at its first request after that, and could never resume after a drop past the two-hour mark. `yungle-client` adds `createTokenKeeper`, `renewUploadToken` and `client.renewUploadToken()` (backed by `POST /api/uploads/token`), and types the new `uploadTokenExpiresAt`. `yungle send`, `push` and `watch` renew automatically and save each renewed token, so a run killed after hours still resumes.

---
"yungle-client": minor
---

End-to-end encrypted transfers: `createTransfer({ e2ee: true })`, `sealTransferFile()` for each file's sealed name and thumbnail, sealed `e2eeMeta` on `finalizeTransfer`, and an `e2ee` flag on transfers so a client never offers a link without its key.

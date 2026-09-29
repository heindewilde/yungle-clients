---
"yungle-client": minor
"yungle-cli": minor
"yungle-mcp": minor
---

Upload requests. `yungle-client` adds `listRequests`, `createRequest`, `getRequest` and `setRequestStatus` (public pages that let other people upload into one of your collections), the `request.submitted` webhook type, and `crc32` on transfer and collection files. `yungle requests` lists them; `yungle requests new --collection <id> --title …` makes one and prints its link; `pause`, `resume`, `close` and `show` manage them. The MCP server can read them (`list_upload_requests`, `get_upload_request`) but not create them: a public upload page is a door into someone's storage, and a model can be steered.

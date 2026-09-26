# yungle

Python client for [Yungle](https://yungle.co/developers?ref=pypi): private, EU-hosted file
transfer, a WeTransfer alternative with an API. Send files of any size as an expiring link, build collections for clients, keep
contacts in sync.

```bash
pip install yungle
export YUNGLE_API_KEY=yk_live_…
```

```python
from yungle import Yungle

yungle = Yungle()
sent = yungle.send(["render.mov", "notes.pdf"], to=["client@example.com"], message="Final cut")
print(sent["url"])
```

`send` creates a draft, uploads each file resumably, and sends it. With no `to` it only
returns a link. Every account can use the API: transfers and contacts on the free plan,
collections on a paid one. The first 10 GB of API uploads each month are free.

- **Every endpoint** is a method: `list_transfers`, `transfer_downloads`,
  `create_collection`, `add_collection_files`, `create_contact`, … Responses are the API's
  JSON as dicts. Reference: <https://yungle.co/developers/reference>
- **Pages** are followed for you by `all_transfers()` and `all_collection_files(id)`.
- **Retries are safe.** Throttles and server errors are retried with backoff, and every
  POST carries an `Idempotency-Key`, so a retried create never makes a second copy.
- **Errors** raise `YungleError`; branch on `err.code`.
- **Uploads** go through `upload_file(tus_endpoint, target, path)`, a small tus client that
  resumes from the server's last committed part.

**Webhooks.** Check a delivery against the raw request body before trusting it:

```python
from yungle import verify_webhook

if not verify_webhook(request.body, request.headers["Yungle-Signature"], secret):
    return HttpResponse(status=400)
```

Source and issues: <https://github.com/heindewilde/yungle-clients>. MIT.

// Send a report file with the SDK: create, upload with tus, finalize.
// npm i yungle-client tus-js-client
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import * as tus from 'tus-js-client';
import { YungleClient } from 'yungle-client';

const path = process.argv[2] ?? 'report.pdf';
const yungle = new YungleClient({ apiKey: process.env.YUNGLE_API_KEY });

const size = statSync(path).size;
const draft = await yungle.createTransfer({
  title: `Nightly report ${new Date().toISOString().slice(0, 10)}`,
  files: [{ name: basename(path), size }],
});

const [target] = draft.files;
await new Promise((resolve, reject) => {
  new tus.Upload(createReadStream(path), {
    endpoint: draft.tusEndpoint,
    uploadSize: size,
    // The token authorizes every tus request, so it goes in a header as well as the metadata.
    headers: { 'x-yungle-upload-token': target.uploadToken },
    metadata: { fileId: target.id, token: target.uploadToken, filename: target.name },
    onSuccess: resolve,
    onError: reject,
  }).start();
});

const { transfer } = await yungle.finalizeTransfer(draft.transfer.id, {
  recipients: ['team@example.com'],
});
console.log(transfer.url);

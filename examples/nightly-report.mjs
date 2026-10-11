// Send a report file with the SDK: create, upload, finalize. Node 22 or later.
// npm i yungle-client
import { openAsBlob, statSync } from 'node:fs';
import { basename } from 'node:path';
import { YungleClient } from 'yungle-client';

const path = process.argv[2] ?? 'report.pdf';
const yungle = new YungleClient({ apiKey: process.env.YUNGLE_API_KEY });

const draft = await yungle.createTransfer({
  title: `Nightly report ${new Date().toISOString().slice(0, 10)}`,
  files: [{ name: basename(path), size: statSync(path).size }],
});

// Resumable, retried, and its upload token renewed for as long as it runs.
await yungle.uploadFile(draft.tusEndpoint, draft.files[0], await openAsBlob(path));

const { transfer } = await yungle.finalizeTransfer(draft.transfer.id, {
  recipients: ['team@example.com'],
});
console.log(transfer.url);

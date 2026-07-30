import { YungleApiError, YungleClient } from 'yungle-client';
import { createInterface } from 'node:readline/promises';
import { listFlag, numberFlag, parseArgs, stringFlag } from './args';
import {
  CONFIG_PATH,
  dropSession,
  findSession,
  readConfig,
  resolveKey,
  saveSession,
  sessionKey,
  writeConfig,
  type UploadSession,
} from './config';
import { collectFiles, formatBytes, pairWithTargets, toFileInputs } from './files';
import { uploadAll } from './upload';

/**
 * `yungle` — the command-line client.
 *
 * Everything here is a thin layer over `yungle-client` plus the tus upload
 * in `upload.ts`. Output goes to stdout as either a human-readable line or, with
 * `--json`, a single JSON object — so the same command serves a person at a
 * terminal and a script parsing its result, without a second code path.
 *
 * Progress and diagnostics go to **stderr**, so `yungle send … --json | jq`
 * works without the progress meter landing in the pipe.
 */

const HELP = `yungle — send and sync files with Yungle

  yungle auth login                       save an API key
  yungle auth status                      show which key is in use
  yungle send <paths…>                    send files, print the share link
    --to <email>          recipient (repeatable, or comma-separated)
    --message <text>      note for the recipients
    --title <text>        label for your dashboard
    --password <text>     recipients must enter this
    --expires <days>      lifetime, clamped to your plan
  yungle push <paths…> --collection <id>  upload into a collection
    --folder <id>         target folder
  yungle ls transfers|collections|contacts
  yungle rm transfer <id>                 revoke a transfer

Global flags
  --json                  machine-readable output
  --url <base>            override the API base URL

Credentials are read from YUNGLE_API_KEY, then ${CONFIG_PATH}.
Docs: https://yungle.co/developers`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const { command, positionals, flags } = parsed;
  const json = flags.json === true;

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(`${HELP}\n`);
        return 0;
      case 'auth':
        return await auth(positionals, flags, json);
      case 'send':
        return await send(positionals, flags, json);
      case 'push':
        return await push(positionals, flags, json);
      case 'ls':
        return await list(positionals, flags, json);
      case 'rm':
        return await remove(positionals, flags, json);
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
        return 2;
    }
  } catch (err) {
    return fail(err, json);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

async function auth(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = positionals[0] ?? 'status';

  if (sub === 'login') {
    // A pasted key rather than a browser round-trip. A loopback OAuth-style
    // dance is nicer and is worth building later; it is also a whole callback
    // server and a new page in the app, and this works on a headless build
    // machine over SSH, which that would not.
    let key = stringFlag(flags.key);
    if (!key) {
      process.stderr.write(
        `Create a key at https://yungle.co/dashboard/settings/api\nand paste it here.\n\n`,
      );
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      key = (await rl.question('API key: ')).trim();
      rl.close();
    }
    if (!key) {
      process.stderr.write('No key given.\n');
      return 2;
    }

    // Verify before saving. Storing a key that does not work turns the next
    // command's 401 into "is it my key or my request?".
    const client = new YungleClient({ apiKey: key, baseUrl: stringFlag(flags.url) });
    const me = await client.me();

    const config = await readConfig();
    await writeConfig({ ...config, apiKey: key, baseUrl: stringFlag(flags.url) ?? config.baseUrl });
    return out(
      json,
      { ok: true, workspace: me.workspace.email, plan: me.plan.name, scopes: me.key.scopes },
      `Signed in as ${me.workspace.email ?? me.workspace.id} (${me.plan.name ?? 'free'}).\nSaved to ${CONFIG_PATH}`,
    );
  }

  if (sub === 'status') {
    const resolved = await resolveKey();
    if (!resolved) {
      return out(json, { authenticated: false }, 'Not signed in. Run `yungle auth login`.', 1);
    }
    const me = await client(flags).me();
    return out(
      json,
      { authenticated: true, source: resolved.source, ...me },
      [
        `Workspace: ${me.workspace.email ?? me.workspace.id}`,
        `Plan:      ${me.plan.name ?? 'free'}`,
        `Storage:   ${formatBytes(me.plan.usedBytes)} of ${formatBytes(me.plan.quotaBytes)}`,
        `Key:       ${me.key.name} (${me.key.scopes.join(', ')})`,
        `Source:    ${resolved.source}`,
      ].join('\n'),
    );
  }

  process.stderr.write('Usage: yungle auth login | yungle auth status\n');
  return 2;
}

async function send(
  paths: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  if (paths.length === 0) {
    process.stderr.write('Nothing to send. Give me one or more files or folders.\n');
    return 2;
  }
  const api = client(flags);
  const files = await collectFiles(paths);
  if (files.length === 0) {
    process.stderr.write('Those paths contained no files.\n');
    return 2;
  }

  const total = files.reduce((n, f) => n + f.size, 0);
  progress(`Sending ${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(total)}\n`);

  /**
   * Resume an interrupted run of the *same* command rather than starting over.
   *
   * The key is derived from the local files, because that is all the next
   * invocation has: it cannot know the transfer id of a process that was
   * killed. Registering the files again instead would leave the earlier draft
   * orphaned and re-upload every byte — which is the whole thing this command
   * is supposed to avoid.
   */
  const key = sessionKey(files, 'transfer');
  const existing = await findSession(key);
  let created: { transfer: { id: string }; tusEndpoint: string; files: UploadSession['files'] };

  if (existing && existing.kind === 'transfer') {
    progress('  resuming the interrupted upload\n');
    created = {
      transfer: { id: existing.targetId },
      tusEndpoint: existing.tusEndpoint,
      files: existing.files,
    };
  } else {
    const fresh = await api.createTransfer({
      files: toFileInputs(files),
      title: stringFlag(flags.title),
      expiresInDays: numberFlag(flags.expires, 'expires'),
    });
    created = { transfer: fresh.transfer, tusEndpoint: fresh.tusEndpoint, files: fresh.files.map((f, i) => ({ ...f, path: files[i]!.path })) };
    // Saved BEFORE a byte moves. Written after the upload, it would only ever
    // describe work that no longer needs resuming.
    await saveSession(key, {
      createdAt: Date.now(),
      kind: 'transfer',
      targetId: fresh.transfer.id,
      tusEndpoint: fresh.tusEndpoint,
      files: created.files,
    });
  }

  await streamAll(files, created, api);
  await dropSession(key);

  const recipients = listFlag(flags.to);
  const finalized = await api.finalizeTransfer(created.transfer.id, {
    ...(recipients.length ? { recipients } : {}),
    ...(stringFlag(flags.message) ? { message: stringFlag(flags.message) } : {}),
    ...(stringFlag(flags.password) ? { password: stringFlag(flags.password) } : {}),
    ...(stringFlag(flags.title) ? { title: stringFlag(flags.title) } : {}),
  });

  return out(
    json,
    {
      id: finalized.transfer.id,
      url: finalized.transfer.url,
      expiresAt: finalized.transfer.expiresAt,
      notified: finalized.notified,
    },
    [
      finalized.transfer.url,
      finalized.notified.length
        ? `Emailed ${finalized.notified.join(', ')}`
        : 'Link only — nobody was emailed.',
    ].join('\n'),
  );
}

async function push(
  paths: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const collectionId = stringFlag(flags.collection);
  if (!collectionId) {
    process.stderr.write('Which collection? Pass --collection <id>.\n');
    return 2;
  }
  if (paths.length === 0) {
    process.stderr.write('Nothing to push.\n');
    return 2;
  }

  const api = client(flags);
  const files = await collectFiles(paths);
  if (files.length === 0) {
    process.stderr.write('Those paths contained no files.\n');
    return 2;
  }

  const total = files.reduce((n, f) => n + f.size, 0);
  progress(`Uploading ${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(total)}\n`);

  const key = sessionKey(files, `collection:${collectionId}:${stringFlag(flags.folder) ?? ''}`);
  const existing = await findSession(key);
  let targets: { tusEndpoint: string; files: UploadSession['files'] };

  if (existing && existing.kind === 'collection') {
    progress('  resuming the interrupted upload\n');
    targets = { tusEndpoint: existing.tusEndpoint, files: existing.files };
  } else {
    const fresh = await api.addCollectionFiles(
      collectionId,
      toFileInputs(files),
      stringFlag(flags.folder) ?? null,
    );
    targets = {
      tusEndpoint: fresh.tusEndpoint,
      files: fresh.files.map((f, i) => ({ ...f, path: files[i]!.path })),
    };
    await saveSession(key, {
      createdAt: Date.now(),
      kind: 'collection',
      targetId: collectionId,
      tusEndpoint: fresh.tusEndpoint,
      files: targets.files,
    });
  }

  await streamAll(files, targets, api);
  await dropSession(key);

  const collection = await api.getCollection(collectionId);
  return out(
    json,
    { collection: collection.collection.id, uploaded: files.length, url: collection.collection.url },
    `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} to “${collection.collection.title}”.\n${collection.collection.url ?? ''}`,
  );
}

async function list(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const what = positionals[0] ?? 'transfers';
  const api = client(flags);

  if (what === 'transfers') {
    const { transfers } = await api.listTransfers();
    return out(
      json,
      { transfers },
      transfers.length === 0
        ? 'No transfers yet.'
        : transfers
            .map(
              (t) =>
                `${t.id}  ${pad(t.title ?? t.firstFileName ?? '(untitled)', 32)} ${pad(formatBytes(t.sizeBytes), 9)} ${t.downloadCount} dl  ${t.url}`,
            )
            .join('\n'),
    );
  }

  if (what === 'collections') {
    const { collections } = await api.listCollections();
    return out(
      json,
      { collections },
      collections.length === 0
        ? 'No collections yet.'
        : collections
            .map(
              (c) =>
                `${c.id}  ${pad(c.title, 32)} ${pad(`${c.fileCount} files`, 12)} ${formatBytes(c.sizeBytes)}`,
            )
            .join('\n'),
    );
  }

  if (what === 'contacts') {
    const { contacts } = await api.listContacts();
    return out(
      json,
      { contacts },
      contacts.length === 0
        ? 'No contacts yet.'
        : contacts
            .map((c) => `${c.id}  ${pad([c.firstName, c.lastName].filter(Boolean).join(' ') || '—', 24)} ${c.email}`)
            .join('\n'),
    );
  }

  process.stderr.write('Usage: yungle ls transfers|collections|contacts\n');
  return 2;
}

async function remove(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const [what, id] = positionals;
  if (what !== 'transfer' || !id) {
    process.stderr.write('Usage: yungle rm transfer <id>\n');
    return 2;
  }
  const { transfer } = await client(flags).revokeTransfer(id);
  return out(
    json,
    { id: transfer.id, status: transfer.status },
    `Revoked. The link no longer works and the content is unrecoverable.`,
  );
}

// ── Plumbing ────────────────────────────────────────────────────────────────

function client(flags: Record<string, string | boolean>): YungleClient {
  const apiKey = process.env.YUNGLE_API_KEY?.trim() ?? cachedKey;
  if (!apiKey) throw new NotSignedIn();
  return new YungleClient({ apiKey, baseUrl: stringFlag(flags.url) ?? cachedBaseUrl });
}

class NotSignedIn extends Error {
  constructor() {
    super('Not signed in. Run `yungle auth login`, or set YUNGLE_API_KEY.');
    this.name = 'NotSignedIn';
  }
}

// Resolved once at startup so every command need not await it.
let cachedKey: string | undefined;
let cachedBaseUrl: string | undefined;

export async function loadCredentials(): Promise<void> {
  const resolved = await resolveKey();
  cachedKey = resolved?.apiKey;
  cachedBaseUrl = resolved?.baseUrl;
}

/**
 * Upload every file, reporting **one** aggregate progress line.
 *
 * Three files upload at once, so a per-file line rewritten with `\r` produces
 * three writers fighting over the same row and output like
 * `IMG_0002 26%  IMG_0001 0%  IMG_0001 36%` on one line — which is what the
 * first version did. The pool is the reason; the fix is to render the batch
 * rather than the file.
 *
 * Per-file bytes are tracked in a map keyed by target id rather than summed
 * from the callbacks, because tus reports cumulative progress per upload and
 * adding deltas would double-count on a retry that restarts a part.
 */
async function streamAll(
  files: Awaited<ReturnType<typeof collectFiles>>,
  targets: { tusEndpoint: string; files: { id: string; name: string; size: number; uploadToken: string }[] },
  _api: YungleClient,
): Promise<void> {
  const paired = pairWithTargets(files, targets.files);
  const totalBytes = paired.reduce((n, { file }) => n + file.size, 0);
  const sentPer = new Map<string, number>();
  const finished = new Set<string>();
  const started = Date.now();
  let anyResumed = false;

  const render = (): void => {
    let sent = 0;
    for (const value of sentPer.values()) sent += value;
    const pct = totalBytes ? Math.floor((sent / totalBytes) * 100) : 100;
    const rate = sent / Math.max(1, (Date.now() - started) / 1000);
    progress(
      `\r  ${String(pct).padStart(3)}%  ${pad(`${formatBytes(sent)} of ${formatBytes(totalBytes)}`, 22)}` +
        `${pad(`${formatBytes(rate)}/s`, 12)}${finished.size}/${paired.length} files${anyResumed ? '  (resumed)' : ''}   `,
    );
  };

  await uploadAll(
    paired.map(({ file, target }) => ({ path: file.path, target })),
    targets.tusEndpoint,
    (p) => {
      if (p.resumed) anyResumed = true;
      sentPer.set(p.id, p.sent);
      if (p.sent >= p.total) finished.add(p.id);
      render();
    },
  );

  render();
  progress('\n');
}

/**
 * Progress and diagnostics go to stderr so `--json | jq` stays clean.
 *
 * Suppressed entirely when stderr is not a terminal: a `\r`-based meter written
 * into a CI log file produces one enormous unreadable line, and the whole point
 * of the carriage return is a cursor that can move.
 */
function progress(text: string): void {
  if (process.stderr.isTTY) process.stderr.write(text);
}

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function out(json: boolean, data: unknown, human: string, code = 0): number {
  process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
  return code;
}

function fail(err: unknown, json: boolean): number {
  if (err instanceof YungleApiError) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }, null, 2)}\n`);
    } else {
      process.stderr.write(`${err.message}\n`);
      // The one error worth adding a next step to, because the fix is not in
      // the request and the message alone reads like a dead end.
      if (err.code === 'upgrade_required') {
        process.stderr.write('See https://yungle.co/dashboard/settings/plan\n');
      }
    }
    return 1;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (json) process.stdout.write(`${JSON.stringify({ error: { code: 'cli_error', message } }, null, 2)}\n`);
  else process.stderr.write(`${message}\n`);
  return 1;
}

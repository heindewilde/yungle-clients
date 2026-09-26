import { YungleApiError, YungleClient } from 'yungle-client';
import { join, resolve } from 'node:path';
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
import {
  dedupeNames,
  downloadTo,
  fetchManifest,
  ManifestError,
  parseTransferLink,
  safeFileName,
  type Manifest,
} from './get';
import {
  mcpClients,
  mergeServerEntry,
  serverEntry,
  writeScopes,
  type ClientId,
  type McpClient,
} from './mcp-install';
import { describeEvent, ensureListenEndpoint, cursorAtNow, signForForward } from './listen';
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

// Replaced with the package version by the build; `dev` under tsx and in tests.
declare const __YUNGLE_CLI_VERSION__: string | undefined;
export const CLI_VERSION =
  typeof __YUNGLE_CLI_VERSION__ === 'string' ? __YUNGLE_CLI_VERSION__ : 'dev';
const USER_AGENT = `yungle-cli/${CLI_VERSION}`;

export const HELP = `yungle — send and sync files with Yungle

  yungle auth login                       save an API key
  yungle auth status                      show which key is in use
  yungle send <paths…>                    send files, print the share link
    --to <email>          recipient (repeatable, or comma-separated)
    --message <text>      note for the recipients
    --title <text>        label for your dashboard
    --password <text>     recipients must enter this
    --expires <days>      lifetime, clamped to your plan
  yungle get <link>                       download a transfer sent to you
    --out <dir>           where to save (default: current directory)
    --zip                 one zip instead of separate files
  yungle push <paths…> --collection <id>  upload into a collection
    --folder <id>         target folder
  yungle ls transfers|collections|contacts
  yungle rm transfer <id>                 revoke a transfer
  yungle webhooks ls                      list webhook endpoints
  yungle webhooks listen                  print events as they happen
    --forward-to <url>    also POST each one, signed, to a local server
  yungle mcp install                      let an AI assistant read your Yungle
    --client <id>         claude-desktop | claude-code | cursor | windsurf
    --dry-run             show what would change, write nothing
  yungle mcp status                       show where it is installed
  yungle --version                        print the version

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
      case 'version':
      case '--version':
      case '-v':
        process.stdout.write(json ? `${JSON.stringify({ version: CLI_VERSION })}\n` : `${CLI_VERSION}\n`);
        return 0;
      case 'auth':
        return await auth(positionals, flags, json);
      case 'send':
        return await send(positionals, flags, json);
      case 'get':
        return await get(positionals, flags, json);
      case 'push':
        return await push(positionals, flags, json);
      case 'ls':
        return await list(positionals, flags, json);
      case 'rm':
        return await remove(positionals, flags, json);
      case 'mcp':
        return await mcp(positionals, flags, json);
      case 'webhooks':
        return await webhooks(positionals, flags, json);
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
    const client = new YungleClient({ apiKey: key, baseUrl: stringFlag(flags.url), userAgent: USER_AGENT });
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

/**
 * Download a transfer from its link. Needs no key — see get.ts.
 *
 * Files go one at a time rather than in a pool: a download is bounded by the
 * recipient's line, not by per-request latency, so parallelism buys little and
 * would make the resume state per file harder to reason about.
 */
async function get(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const input = positionals[0];
  if (!input) {
    process.stderr.write('Usage: yungle get <link> [--out <dir>] [--zip]\n');
    return 2;
  }
  const apiBase = stringFlag(flags.url) ?? cachedBaseUrl ?? 'https://yungle.co/api/v1';
  const link = parseTransferLink(input, new URL(apiBase).origin);
  const outDir = resolve(stringFlag(flags.out) ?? '.');

  let password = stringFlag(flags.password);
  let manifest: Manifest;
  for (;;) {
    try {
      manifest = await fetchManifest(link, password, USER_AGENT);
      break;
    } catch (err) {
      const needsPassword = err instanceof ManifestError && (err.code === 'password_required' || err.code === 'wrong_password');
      if (!needsPassword || !process.stdin.isTTY || json) {
        if (err instanceof ManifestError && err.code === 'password_required') {
          throw new Error('This transfer is password protected. Pass --password, or run it in a terminal to be asked.');
        }
        throw err;
      }
      if (err.code === 'wrong_password') process.stderr.write('That password is not right.\n');
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      password = (await rl.question('Password: ')).trim();
      rl.close();
      if (!password) return 2;
    }
  }

  if (manifest.e2ee) {
    throw new Error(
      'This transfer is end-to-end encrypted, so only a browser holding the key in the link can open it. ' +
        'Open the link in a browser. (`yungle get` does not decrypt yet.)',
    );
  }
  if (manifest.files.length === 0) return out(json, { saved: [] }, 'This transfer has no files.');

  const useZip = flags.zip === true && manifest.zipUrl !== null;
  const jobs = useZip
    ? [{ url: manifest.zipUrl!, name: `yungle-${link.slug}.zip`, size: null as number | null }]
    : dedupeNames(manifest.files.map((f) => safeFileName(f.name))).map((name, i) => ({
        url: manifest.files[i]!.downloadUrl,
        name,
        size: manifest.files[i]!.size as number | null,
      }));

  const total = useZip ? null : manifest.files.reduce((n, f) => n + f.size, 0);
  let received = 0;
  const started = Date.now();
  const saved: string[] = [];
  for (const [i, job] of jobs.entries()) {
    const dest = join(outDir, job.name);
    await downloadTo(job.url, dest, job.size, USER_AGENT, (n) => {
      received += n;
      const rate = received / Math.max(1, (Date.now() - started) / 1000);
      const of = total ? ` of ${formatBytes(total)}` : '';
      progress(`\r  ${pad(`${formatBytes(received)}${of}`, 24)}${pad(`${formatBytes(rate)}/s`, 12)}${i + 1}/${jobs.length} files   `);
    });
    saved.push(dest);
  }
  progress('\n');

  const note = manifest.message ? `\n“${manifest.message}”` : '';
  return out(
    json,
    { saved, message: manifest.message, expiresAt: manifest.expiresAt },
    `Saved ${saved.length === 1 ? saved[0] : `${saved.length} files to ${outDir}`}${note}`,
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
  return new YungleClient({ apiKey, baseUrl: stringFlag(flags.url) ?? cachedBaseUrl, userAgent: USER_AGENT });
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
  // A download error carries the server's code (wrong_password, expired, …),
  // which a script branches on; everything else is ours.
  const code = err instanceof ManifestError ? err.code : 'cli_error';
  if (json) process.stdout.write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
  else process.stderr.write(`${message}\n`);
  return 1;
}

// ── yungle webhooks ─────────────────────────────────────────────────────────

async function webhooks(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const api = client(flags);
  const sub = positionals[0] ?? 'ls';
  if (sub === 'ls') {
    const { webhooks } = await api.listWebhooks();
    const rows = webhooks.map(
      (w) => `${pad(w.id, 28)}${pad(w.enabled ? 'active' : 'paused', 8)}${w.url ?? '(pull)'}  ${w.events.join(',')}`,
    );
    return out(json, { webhooks }, rows.length ? rows.join('\n') : 'No webhook endpoints.');
  }
  if (sub !== 'listen') {
    process.stderr.write('Usage: yungle webhooks ls | listen [--forward-to <url>]\n');
    return 2;
  }

  const forwardTo = stringFlag(flags['forward-to']);
  const { id, secret } = await ensureListenEndpoint(api);
  let cursor = await cursorAtNow(api, id);
  process.stderr.write(
    `Listening for events${forwardTo ? `, forwarding to ${forwardTo}` : ''}. Ctrl-C to stop.\n` +
      (forwardTo ? `Signing secret for this session: ${secret}\n` : ''),
  );

  for (;;) {
    const page = await api.listWebhookEvents(id, { limit: 100, cursor });
    for (const { deliveryId, ...event } of page.events) {
      const body = JSON.stringify(event);
      if (json) process.stdout.write(`${body}\n`);
      else process.stdout.write(`${event.createdAt.slice(11, 19)}  ${pad(event.type, 26)}${describeEvent(event)}\n`);
      if (forwardTo) {
        const res = await fetch(forwardTo, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
            'Yungle-Event-Id': event.id,
            'Yungle-Event-Type': event.type,
            'Yungle-Delivery-Id': deliveryId,
            'Yungle-Signature': signForForward(secret, body),
          },
          body,
        }).catch((err: Error) => ({ ok: false, status: err.message }) as const);
        if (!json) process.stderr.write(`          → ${forwardTo} ${'status' in res ? res.status : ''}\n`);
      }
    }
    cursor = page.nextCursor ?? cursor;
    if (!page.hasMore) await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── yungle mcp ──────────────────────────────────────────────────────────────

/**
 * Install the Yungle MCP server into whichever agent clients are present.
 *
 * The point is to remove five steps that each lose people: find the config file,
 * learn its schema, edit it without breaking the servers already in it, paste a
 * key, restart. The safety rules for touching those files live in
 * `mcp-install.ts`; this function is the I/O around them.
 */
async function mcp(
  positionals: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = positionals[0] ?? 'install';
  if (sub !== 'install' && sub !== 'status') {
    process.stderr.write('Usage: yungle mcp install | yungle mcp status\n');
    return 2;
  }

  const { readFile, writeFile, mkdir, copyFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const all = mcpClients();
  const only = stringFlag(flags.client);
  if (only && !all.some((c) => c.id === only)) {
    process.stderr.write(
      `Unknown client: ${only}. Known: ${all.map((c) => c.id).join(', ')}\n`,
    );
    return 2;
  }
  const targets = only ? all.filter((c) => c.id === only) : all;

  // `status` reads and reports; it needs no credential, which matters because
  // "where is this installed" is exactly what someone asks when their key is the
  // thing that is wrong.
  if (sub === 'status') {
    const rows: Array<{ client: ClientId; path: string | null; installed: boolean }> = [];
    for (const c of targets) {
      let installed = false;
      if (c.configPath) {
        try {
          const doc = JSON.parse(await readFile(c.configPath, 'utf8')) as Record<string, unknown>;
          const servers = doc[c.serversKey];
          installed =
            !!servers && typeof servers === 'object' && 'yungle' in (servers as object);
        } catch {
          installed = false;
        }
      }
      rows.push({ client: c.id, path: c.configPath, installed });
    }
    return out(
      json,
      { clients: rows },
      rows
        .map(
          (r) =>
            `${pad(r.client, 16)} ${r.installed ? 'installed' : r.path ? 'not installed' : 'n/a on this platform'}`,
        )
        .join('\n'),
    );
  }

  // ── install ───────────────────────────────────────────────────────────────
  const resolved = await resolveKey();
  if (!resolved) {
    process.stderr.write(
      `No API key. Run \`yungle auth login\` first, or set YUNGLE_API_KEY.\nGet a key at https://yungle.co/dashboard/settings/api — reading is free on any plan.\n`,
    );
    return 1;
  }

  /**
   * Refuse a key that can write.
   *
   * The MCP server has no tool that mutates anything, so a write scope buys
   * nothing here and costs real safety: a model can be steered by a filename in
   * a collection it was asked to summarise, and MCP has no confirmation
   * primitive. The only durable guarantee is a credential that cannot mutate.
   *
   * This is the one part of install that needs the network. It fails CLOSED — if
   * the scopes cannot be read, nothing is written, because installing a key of
   * unknown power into an agent's config is the outcome worth avoiding.
   */
  let scopes: string[];
  try {
    const me = await client(flags).me();
    scopes = me.key.scopes ?? [];
  } catch (err) {
    process.stderr.write(
      `Could not check what this key is allowed to do: ${(err as Error).message}\n` +
        `Not installing — an agent should never get a key of unknown scope.\n`,
    );
    return 1;
  }
  const writes = writeScopes(scopes);
  if (writes.length > 0) {
    process.stderr.write(
      `This key can write (${writes.join(', ')}).\n\n` +
        `The MCP server has no tool that sends, invites, revokes or deletes, so a\n` +
        `write scope grants an assistant nothing it can use — but it does put a\n` +
        `credential that can change your account into a config file an assistant\n` +
        `reads. Create a read-only key instead:\n\n` +
        `  https://yungle.co/dashboard/settings/api\n\n` +
        `then \`yungle auth login\` with it and re-run this.\n`,
    );
    return 1;
  }

  const entry = serverEntry({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
  const dryRun = flags['dry-run'] === true;
  const results: Array<{ client: ClientId; action: string; path?: string; detail?: string }> = [];

  for (const c of targets) {
    const r = await installInto(c, entry, { dryRun, readFile, writeFile, mkdir, copyFile, dirname });
    results.push({ client: c.id, ...r });
  }

  const changed = results.filter((r) => r.action === 'added' || r.action === 'updated');
  const lines = results.map((r) => `${pad(r.client, 16)} ${r.action}${r.detail ? ` — ${r.detail}` : ''}`);

  if (changed.length > 0 && !dryRun) {
    lines.push('');
    // Every one of these clients reads its MCP config at startup only. Without
    // this line the install looks like it silently failed.
    lines.push('Restart the client(s) above to pick it up.');
    lines.push('Then ask: "what did I send recently?" or "did the client download it?"');
    lines.push('');
    lines.push(`Your API key is now also in ${changed.length === 1 ? 'that config file' : 'those config files'}, in plain text.`);
  }
  if (changed.length === 0 && !dryRun) {
    lines.push('');
    lines.push('Nothing to do. `yungle mcp status` shows where it is installed.');
  }

  return out(json, { installed: results, dryRun }, lines.join('\n'));
}

/** One client's config. Returns what happened rather than printing, so `--json` works. */
async function installInto(
  c: McpClient,
  entry: ReturnType<typeof serverEntry>,
  io: {
    dryRun: boolean;
    readFile: (p: string, e: 'utf8') => Promise<string>;
    writeFile: (p: string, d: string, o?: object) => Promise<void>;
    mkdir: (p: string, o?: object) => Promise<unknown>;
    copyFile: (a: string, b: string) => Promise<void>;
    dirname: (p: string) => string;
  },
): Promise<{ action: string; path?: string; detail?: string }> {
  if (!c.configPath) return { action: 'skipped', detail: 'not available on this platform' };

  /**
   * Claude Code owns `~/.claude.json`, which carries conversation state, project
   * history and onboarding flags as well as MCP servers — and it rewrites that
   * file underneath us. Hand-editing it is unsupported, so delegate.
   */
  if (c.viaCli) {
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(c.viaCli.bin, ['--version'], { stdio: 'ignore', shell: false });
    if (probe.error) return { action: 'skipped', detail: `${c.viaCli.bin} not installed` };
    if (io.dryRun) {
      return { action: 'would run', detail: `${c.viaCli.bin} mcp add-json -s user yungle …` };
    }

    /**
     * `add-json` refuses an existing name rather than replacing it, so a second
     * run reported `failed` for something that was in fact installed — and, worse,
     * a run after `yungle auth login` left the OLD key in place while looking like
     * it had merely done nothing.
     *
     * So remove first. The removal is allowed to fail: on a clean machine there is
     * nothing to remove, and that is the normal case rather than an error.
     */
    const existed =
      spawnSync(c.viaCli.bin, ['mcp', 'get', 'yungle'], { stdio: 'ignore', shell: false })
        .status === 0;
    if (existed) {
      spawnSync(c.viaCli.bin, ['mcp', 'remove', '-s', 'user', 'yungle'], {
        stdio: 'ignore',
        shell: false,
      });
    }

    const res = spawnSync(c.viaCli.bin, c.viaCli.args('yungle', JSON.stringify(entry)), {
      stdio: 'pipe',
      shell: false,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      const why = (res.stderr || res.stdout || '').trim().split('\n')[0] || `exit ${res.status}`;
      return { action: 'failed', detail: why };
    }
    return {
      action: existed ? 'updated' : 'added',
      detail: `via ${c.viaCli.bin} mcp add-json`,
    };
  }

  // Only touch a client that is actually installed. Creating the config for one
  // that is not present writes a file nothing reads and reports a success that
  // did not happen.
  let raw: string | null = null;
  try {
    raw = await io.readFile(c.configPath, 'utf8');
  } catch {
    let dirExists = true;
    try {
      await io.readFile(io.dirname(c.configPath), 'utf8');
    } catch (err) {
      // EISDIR means the directory is there, which is what we are testing for.
      dirExists = (err as NodeJS.ErrnoException).code === 'EISDIR';
    }
    if (!dirExists) return { action: 'skipped', detail: 'not installed' };
  }

  /**
   * A config we cannot parse is a config we must not write.
   *
   * It holds every other MCP server this person has set up. Overwriting it with
   * a fresh document containing only Yungle would be the single worst thing this
   * command could do, and "it had a trailing comma" is not a reason to do it.
   */
  let existing: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      existing = JSON.parse(raw);
    } catch {
      return {
        action: 'refused',
        path: c.configPath,
        detail: `${c.configPath} is not valid JSON — fix or move it, nothing was written`,
      };
    }
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      return {
        action: 'refused',
        path: c.configPath,
        detail: `${c.configPath} is not a JSON object — nothing was written`,
      };
    }
  }

  const merged = mergeServerEntry(existing, c.serversKey, 'yungle', entry);
  if (merged.kind === 'unchanged') return { action: 'already current', path: c.configPath };
  if (io.dryRun) {
    return { action: `would be ${merged.kind}`, path: c.configPath, detail: c.configPath };
  }

  // Back up before the first modification. Cheap, and the difference between an
  // annoyance and a person losing their agent setup.
  if (raw !== null) {
    try {
      await io.copyFile(c.configPath, `${c.configPath}.yungle-bak`);
    } catch {
      // A failed backup is not a reason to abort — the merge preserves
      // everything by construction and is unit-tested to. But say so.
    }
  }
  await io.mkdir(io.dirname(c.configPath), { recursive: true });
  await io.writeFile(c.configPath, `${JSON.stringify(merged.config, null, 2)}\n`, { mode: 0o600 });
  return { action: merged.kind, path: c.configPath, detail: c.configPath };
}

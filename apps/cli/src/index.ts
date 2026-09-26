import { isAbsolute, join, relative, resolve } from 'node:path';
import { YungleClient, type Me, type TransferSummary } from 'yungle-client';
import { listFlag, numberFlag, parseArgs, stringFlag } from './args';
import { completionScript } from './completion';
import {
  CONFIG_PATH,
  dropSession,
  findSession,
  originOf,
  readConfig,
  resolveKey,
  saveSession,
  sessionKey,
  writeConfig,
  type UploadSession,
} from './config';
import { CliError, NotSignedIn, suggest } from './errors';
import { collectFiles, pairWithTargets, toFileInputs, type LocalFile } from './files';
import { dedupeNames, downloadTo, fetchManifest, ManifestError, parseTransferLink, safeFileName, type Manifest } from './get';
import { askKey, askLink, askPassword, askSend, confirm, pick } from './guided';
import { COMMANDS, commandHelp, HELP, renderHelp, resolveAlias } from './help';
import { cursorAtNow, describeEvent, ensureListenEndpoint, signForForward } from './listen';
import { deviceLogin, logout, openBrowser } from './login';
import { mcp } from './mcp-command';
import { fail, out } from './output';
import {
  accentOut,
  drawProgress,
  e,
  endProgress,
  formatBytes,
  formatDate,
  formatUntil,
  heading,
  interactive,
  next,
  note,
  o,
  plural,
  progressLine,
  success,
  sym,
  table,
} from './ui';
import { uploadAll } from './upload';
import { fingerprint, loadUploaded, planTick, saveUploaded } from './watch';

/**
 * `yungle` — the command-line client.
 *
 * A thin layer over `yungle-client` plus the tus upload in `upload.ts`. Results
 * go to stdout (pretty at a terminal, plain in a pipe, JSON with --json);
 * progress and diagnostics go to stderr, so `yungle send … --json | jq` works
 * with the progress bar still on screen. How it looks is in `ui.ts`; what it
 * says when something fails is in `errors.ts`.
 */

// Replaced with the package version by the build; `dev` under tsx and in tests.
declare const __YUNGLE_CLI_VERSION__: string | undefined;
export const CLI_VERSION = typeof __YUNGLE_CLI_VERSION__ === 'string' ? __YUNGLE_CLI_VERSION__ : 'dev';
const USER_AGENT = `yungle-cli/${CLI_VERSION}`;

export { HELP };

type Flags = Record<string, string | boolean>;

export async function main(argvIn: string[]): Promise<number> {
  const argv = resolveAlias(argvIn);
  let parsed;
  try {
    parsed = parseArgs(argv.length ? argv : ['help']);
  } catch (err) {
    return fail(new CliError((err as Error).message, 'yungle help', 'usage', 2), false);
  }
  const { command, positionals, flags } = parsed;
  const json = flags.json === true;

  try {
    if (flags.help === true && command !== 'help') return help([command], json);
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        // `yungle` on its own, at a terminal, offers the common things instead.
        if (argvIn.length === 0 && interactive(flags)) return await menu(flags);
        return help(positionals, json);
      case 'version':
      case '--version':
      case '-v':
        return out(json, { version: CLI_VERSION }, CLI_VERSION);
      case 'login':
        return await login(flags, json);
      case 'logout': {
        const had = await logout(stringFlag(flags.url));
        return out(json, { signedOut: had }, had ? success('Signed out', [o.dim('The session is revoked.')]) : '  Not signed in with `yungle login`; nothing to do.');
      }
      case 'whoami':
        return await whoami(flags, json);
      case 'send':
        return await send(positionals, flags, json);
      case 'get':
        return await get(positionals, flags, json);
      case 'status':
        return await status(positionals, flags, json);
      case 'transfers':
        return await transfers(flags, json);
      case 'collections':
        return await collections(flags, json);
      case 'contacts':
        return await contacts(flags, json);
      case 'revoke':
        return await revoke(positionals, flags, json);
      case 'push':
        return await push(positionals, flags, json);
      case 'watch':
        return await watch(positionals, flags, json);
      case 'open':
        return await open(positionals, flags, json);
      case 'webhooks':
        return await webhooks(positionals, flags, json);
      case 'mcp':
        return await mcp(positionals, flags, json, client);
      case 'completion': {
        const script = completionScript(positionals[0] ?? '');
        if (!script) throw new CliError('Which shell?', 'yungle completion zsh | bash | fish', 'usage', 2);
        process.stdout.write(script);
        return 0;
      }
      default: {
        const guess = suggest(command, COMMANDS);
        throw new CliError(`Unknown command: ${command}.`, guess ? `yungle ${guess}   (did you mean this?)` : 'yungle help', 'usage', 2);
      }
    }
  } catch (err) {
    endProgress();
    return fail(err, json);
  }
}

// ── Help and the menu ───────────────────────────────────────────────────────

function help(positionals: string[], json: boolean): number {
  const topic = positionals[0];
  if (topic) {
    const text = commandHelp(topic);
    if (!text) {
      const guess = suggest(topic, COMMANDS);
      throw new CliError(`No help for "${topic}".`, guess ? `yungle help ${guess}` : 'yungle help', 'usage', 2);
    }
    return out(json, { command: topic, help: text }, renderHelp(text), text);
  }
  return out(json, { help: HELP }, renderHelp(HELP), HELP);
}

/** `yungle` with nothing after it, at a terminal. */
async function menu(flags: Flags): Promise<number> {
  const signedIn = Boolean(await resolveKey());
  const choice = await pick('What would you like to do?', [
    ...(signedIn ? [] : [{ value: 'login', label: 'Sign in', hint: 'opens your browser' }]),
    { value: 'send', label: 'Send files or a folder' },
    { value: 'get', label: 'Download a link someone sent you' },
    ...(signedIn ? [{ value: 'status', label: 'See who downloaded a transfer' }, { value: 'open', label: 'Open the dashboard' }] : []),
    { value: 'help', label: 'Show all commands' },
  ]);
  if (choice === 'help') return help([], false);
  return main([choice, ...(stringFlag(flags.url) ? ['--url', stringFlag(flags.url)!] : [])]);
}

// ── Signing in ──────────────────────────────────────────────────────────────

async function login(flags: Flags, json: boolean): Promise<number> {
  const url = stringFlag(flags.url);
  if (flags.key !== undefined) {
    // A pasted key: for servers and CI, where there is no browser to hand.
    let key = stringFlag(flags.key);
    if (!key) {
      if (!interactive(flags)) throw new CliError('Give the key: --key yk_live_…', undefined, 'usage', 2);
      key = await askKey();
    }
    // Verify before saving: storing a key that does not work turns the next
    // command's 401 into "is it my key or my request?".
    const me = await new YungleClient({ apiKey: key, baseUrl: url, userAgent: USER_AGENT }).me();
    const config = await readConfig();
    await writeConfig({ ...config, apiKey: key, baseUrl: url ?? config.baseUrl });
    return out(
      json,
      { ok: true, workspace: me.workspace.email, plan: me.plan.name, scopes: me.key.scopes },
      success(`Signed in as ${me.workspace.email ?? me.workspace.id}`, [o.dim(`with key ${me.key.name} · saved to ${CONFIG_PATH}`)]),
    );
  }
  const scope = await deviceLogin(url, { openBrowser: flags['no-browser'] !== true });
  await loadCredentials();
  const me = await client(flags).me().catch(() => null);
  return out(
    json,
    { signedIn: true, scope, workspace: me?.workspace.email ?? null },
    [
      success(`Signed in${me?.workspace.email ? ` as ${me.workspace.email}` : ''}`, [o.dim(scope.split(' ').join(', '))]),
      '',
      next('yungle send <folder>', 'send something'),
    ].join('\n'),
  );
}

async function whoami(flags: Flags, json: boolean): Promise<number> {
  const resolved = await resolveKey();
  if (!resolved) throw new NotSignedIn();
  const me: Me = await client(flags).me();
  const via = resolved.source.includes('(yungle login)') ? 'browser sign-in' : resolved.source === 'YUNGLE_API_KEY' ? 'YUNGLE_API_KEY' : `key in ${CONFIG_PATH}`;
  return out(
    json,
    { authenticated: true, source: resolved.source, ...me },
    [
      `  ${o.bold(me.workspace.email ?? me.workspace.id)}  ${o.dim(me.plan.name ?? 'Free plan')}`,
      `  ${o.dim('Storage')}   ${formatBytes(me.plan.usedBytes)} of ${formatBytes(me.plan.quotaBytes)}`,
      `  ${o.dim('Signed in')} ${via} ${o.dim(`(${me.key.name})`)}`,
      `  ${o.dim('May')}       ${me.key.scopes.join(', ')}`,
    ].join('\n'),
    me.workspace.email ?? me.workspace.id,
  );
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function send(pathsIn: string[], flags: Flags, json: boolean): Promise<number> {
  let paths = pathsIn;
  let recipients = listFlag(flags.to);
  let message = stringFlag(flags.message);
  let askedFor = false;
  if (paths.length === 0) {
    if (!interactive(flags)) throw new CliError('Nothing to send.', 'yungle send <file or folder> [--to someone@example.com]', 'usage', 2);
    const answers = await askSend();
    paths = answers.paths;
    recipients = answers.to;
    message = answers.message;
    askedFor = true;
  }

  const api = client(flags);
  const files = await collectFiles(paths);
  if (files.length === 0) throw new CliError('Those paths contain no files (hidden files are skipped).', undefined, 'usage', 2);
  const total = files.reduce((n, f) => n + f.size, 0);
  const summary = `${plural(files.length, 'file')} ${sym.dot} ${formatBytes(total)}${recipients.length ? ` to ${recipients.join(', ')}` : ''}`;

  if (askedFor && !(await confirm(`Send ${summary}?`))) throw new CliError('Cancelled; nothing was sent.', undefined, 'cancelled', 130);
  heading(`Sending ${summary}`);

  /**
   * Resume an interrupted run of the *same* command rather than starting over.
   * The key is derived from the local files, because that is all the next
   * invocation has: it cannot know the transfer id of a process that was killed.
   */
  const key = sessionKey(files, 'transfer');
  const existing = await findSession(key);
  let created: { transfer: { id: string }; tusEndpoint: string; files: UploadSession['files'] };
  if (existing && existing.kind === 'transfer') {
    note('Resuming the interrupted upload.');
    created = { transfer: { id: existing.targetId }, tusEndpoint: existing.tusEndpoint, files: existing.files };
  } else {
    const fresh = await api.createTransfer({
      files: toFileInputs(files),
      title: stringFlag(flags.title),
      expiresInDays: numberFlag(flags.expires, 'expires'),
    });
    created = { transfer: fresh.transfer, tusEndpoint: fresh.tusEndpoint, files: fresh.files.map((f, i) => ({ ...f, path: files[i]!.path })) };
    // Saved BEFORE a byte moves: written after, it would only ever describe
    // work that no longer needs resuming.
    await saveSession(key, { createdAt: Date.now(), kind: 'transfer', targetId: fresh.transfer.id, tusEndpoint: fresh.tusEndpoint, files: created.files });
  }

  await streamAll(files, created);
  // An upload can outlast a `yungle login` access token; refresh before the
  // call that makes the transfer live, not after it fails.
  const after = await freshClient(flags, api);
  await dropSession(key);

  const finalized = await after.finalizeTransfer(created.transfer.id, {
    ...(recipients.length ? { recipients } : {}),
    ...(message ? { message } : {}),
    ...(stringFlag(flags.password) ? { password: stringFlag(flags.password) } : {}),
    ...(stringFlag(flags.title) ? { title: stringFlag(flags.title) } : {}),
  });
  const t = finalized.transfer;
  return out(
    json,
    { id: t.id, url: t.url, expiresAt: t.expiresAt, notified: finalized.notified },
    [
      success('Sent', [
        accentOut(t.url),
        o.dim(
          `${finalized.notified.length ? `Emailed ${finalized.notified.join(', ')}` : 'Link only; nobody was emailed'} ${sym.dot} expires ${formatDate(t.expiresAt)}`,
        ),
      ]),
      '',
      next(`yungle status ${t.id.slice(-8)}`, 'see who downloaded'),
    ].join('\n'),
    t.url,
  );
}

/**
 * Upload every file, rendering **one** aggregate progress line: three files
 * upload at once, and a line per file would have three writers fighting over
 * one row. Per-file bytes are kept in a map because tus reports cumulative
 * progress per upload, and adding deltas would double-count a retried part.
 */
async function streamAll(
  files: LocalFile[],
  targets: { tusEndpoint: string; files: { id: string; name: string; size: number; uploadToken: string }[] },
): Promise<void> {
  const paired = pairWithTargets(files, targets.files);
  const totalBytes = paired.reduce((n, { file }) => n + file.size, 0);
  const sentPer = new Map<string, number>();
  const finished = new Set<string>();
  const started = Date.now();
  let resumed = false;
  const render = () => {
    let sent = 0;
    for (const v of sentPer.values()) sent += v;
    drawProgress(progressLine(sent, totalBytes, started, `${finished.size}/${paired.length} files${resumed ? ' (resumed)' : ''}`));
  };
  const timer = setInterval(render, 250);
  try {
    await uploadAll(
      paired.map(({ file, target }) => ({ path: file.path, target })),
      targets.tusEndpoint,
      (p) => {
        if (p.resumed) resumed = true;
        sentPer.set(p.id, p.sent);
        if (p.sent >= p.total) finished.add(p.id);
      },
    );
  } finally {
    clearInterval(timer);
    endProgress();
  }
}

// ── Receiving ───────────────────────────────────────────────────────────────

/**
 * Download a transfer from its link. Needs no key — see get.ts. Files go one at
 * a time: a download is bounded by the line, not by per-request latency.
 */
async function get(positionals: string[], flags: Flags, json: boolean): Promise<number> {
  let input = positionals[0];
  if (!input) {
    if (!interactive(flags)) throw new CliError('Which link?', 'yungle get https://yungle.co/t/…', 'usage', 2);
    input = await askLink();
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
      const needs = err instanceof ManifestError && (err.code === 'password_required' || err.code === 'wrong_password');
      if (!needs || !interactive(flags)) {
        if (err instanceof ManifestError && err.code === 'password_required') {
          throw new CliError('This transfer is password protected.', `yungle get ${input} --password <password>`, 'password_required');
        }
        throw err;
      }
      if (err.code === 'wrong_password') note('That password is not right.');
      password = await askPassword();
    }
  }

  if (manifest.e2ee) {
    throw new CliError(
      'This transfer is end-to-end encrypted: only a browser holding the key in the link can open it.',
      'Open the link in a browser.',
      'e2ee',
    );
  }
  if (manifest.files.length === 0) return out(json, { saved: [] }, '  This transfer has no files.');

  const useZip = flags.zip === true && manifest.zipUrl !== null;
  const jobs = useZip
    ? [{ url: manifest.zipUrl!, name: `yungle-${link.slug}.zip`, size: null as number | null }]
    : dedupeNames(manifest.files.map((f) => safeFileName(f.name))).map((name, i) => ({ url: manifest.files[i]!.downloadUrl, name, size: manifest.files[i]!.size as number | null }));

  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  heading(`Downloading ${plural(manifest.files.length, 'file')} ${sym.dot} ${formatBytes(total)}`);
  let received = 0;
  const started = Date.now();
  const saved: string[] = [];
  for (const [i, job] of jobs.entries()) {
    const dest = join(outDir, job.name);
    await downloadTo(job.url, dest, job.size, USER_AGENT, (n) => {
      received += n;
      drawProgress(progressLine(Math.min(received, total), total, started, `${i + 1}/${jobs.length} files`));
    });
    saved.push(dest);
  }
  endProgress();
  return out(
    json,
    { saved, message: manifest.message, expiresAt: manifest.expiresAt },
    success(`Saved ${saved.length === 1 ? shown(saved[0]!) : `${plural(saved.length, 'file')} to ${shown(outDir)}`}`, manifest.message ? [o.italic(`“${manifest.message}”`)] : []),
    saved.join('\n'),
  );
}

/** A path as a person would type it: relative when it is under here. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  return !rel ? '.' : rel.startsWith('..') || isAbsolute(rel) ? path : `./${rel}`;
}

// ── Looking things up ───────────────────────────────────────────────────────

/**
 * A transfer from whatever the person has to hand: the full id, the short id
 * `yungle transfers` shows (its last eight characters), or the link.
 */
async function findTransferId(api: YungleClient, ref: string): Promise<string> {
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ref)) return ref;
  const slug = ref.match(/\/t\/([^/?#]+)/)?.[1] ?? ref;
  const short = /^[0-9A-HJKMNP-TV-Z]{6,25}$/i.test(ref) ? ref.toUpperCase() : null;
  for await (const t of api.allTransfers()) {
    if (t.slug === slug || (short && t.id.endsWith(short))) return t.id;
  }
  throw new CliError('None of your transfers matches that.', 'yungle transfers', 'not_found');
}

async function status(positionals: string[], flags: Flags, json: boolean): Promise<number> {
  const api = client(flags);
  let ref = positionals[0];
  if (!ref) {
    if (!interactive(flags)) throw new CliError('Which transfer?', 'yungle status <id or link>', 'usage', 2);
    const { transfers } = await api.listTransfers({ limit: 15 });
    if (transfers.length === 0) throw new CliError('You have not sent anything yet.', 'yungle send <folder>');
    ref = await pick(
      'Which transfer?',
      transfers.map((t) => ({ value: t.id, label: label(t), hint: `${formatDate(t.createdAt)} ${sym.dot} ${t.downloadCount} downloads` })),
    );
  }
  const id = await findTransferId(api, ref);
  const [{ transfer: t, files, recipients }, receipts] = await Promise.all([api.getTransfer(id), api.transferDownloads(id)]);
  const live = t.status === 'active' && !(t.expiresAt && new Date(t.expiresAt).getTime() < Date.now());
  const state = live ? accentOut(`${sym.ok} live ${sym.dot} expires ${formatUntil(t.expiresAt)}`) : o.dim(`${t.status === 'active' ? 'expired' : t.status}`);
  const lines = [
    `  ${o.bold(t.title ?? (files[0] ? `${files[0].name}${files.length > 1 ? ` + ${files.length - 1} more` : ''}` : 'Untitled transfer'))}   ${state}`,
    `  ${accentOut(t.url)}`,
    `  ${o.dim(`${plural(files.length, 'file')} ${sym.dot} ${formatBytes(t.sizeBytes)} ${sym.dot} ${receipts.totalDownloads ? `downloaded ${plural(receipts.totalDownloads, 'time')}` : 'not downloaded yet'}`)}`,
  ];
  if (recipients.length) {
    lines.push('', table(
      recipients.map((r) => [
        r.email,
        r.bouncedAt ? o.red('email bounced') : r.downloaded ? accentOut('downloaded') : r.opened ? 'opened' : r.notifiedAt ? o.dim('emailed') : o.dim('email queued'),
      ]),
      { flex: 0, header: ['Recipient', 'Status'] },
    ));
  }
  const last = receipts.downloads[0];
  if (last) lines.push('', `  ${o.dim(`Last download ${formatDate(last.createdAt)}${last.recipientEmail ? ` by ${last.recipientEmail}` : ''}`)}`);
  return out(json, { transfer: t, files, recipients, downloads: receipts }, lines.join('\n'), `${t.url}\t${receipts.totalDownloads}`);
}

function label(t: TransferSummary): string {
  return t.title ?? t.firstFileName ?? 'Untitled';
}

async function transfers(flags: Flags, json: boolean): Promise<number> {
  const { transfers } = await client(flags).listTransfers({ limit: 25 });
  if (transfers.length === 0) return out(json, { transfers }, `  No transfers yet.\n\n${next('yungle send <folder>')}`, '');
  return out(
    json,
    { transfers },
    table(
      transfers.map((t) => [
        o.dim(t.id.slice(-8)),
        label(t),
        formatBytes(t.sizeBytes),
        t.downloadCount ? accentOut(`${t.downloadCount} dl`) : o.dim('0 dl'),
        t.status === 'active' ? formatUntil(t.expiresAt) : o.dim(t.status),
      ]),
      // No link column: a link cut to fit cannot be copied. `status` shows it.
      { flex: 1, header: ['ID', 'Title', 'Size', 'Downloads', 'Expires'] },
    ) + `\n\n${next('yungle status <id>', 'who downloaded')}`,
    transfers.map((t) => `${t.id}\t${t.url}`).join('\n'),
  );
}

async function collections(flags: Flags, json: boolean): Promise<number> {
  const { collections } = await client(flags).listCollections();
  if (collections.length === 0) return out(json, { collections }, '  No collections yet.', '');
  return out(
    json,
    { collections },
    table(
      collections.map((c) => [o.dim(c.id), c.title, plural(c.fileCount, 'file'), formatBytes(c.sizeBytes)]),
      { flex: 1, header: ['ID', 'Title', 'Files', 'Size'] },
    ),
    collections.map((c) => `${c.id}\t${c.title}`).join('\n'),
  );
}

async function contacts(flags: Flags, json: boolean): Promise<number> {
  const { contacts } = await client(flags).listContacts();
  if (contacts.length === 0) return out(json, { contacts }, '  No contacts yet.', '');
  return out(
    json,
    { contacts },
    table(
      contacts.map((c) => [[c.firstName, c.lastName].filter(Boolean).join(' ') || o.dim('—'), c.email, o.dim(c.company ?? '')]),
      { flex: 0, header: ['Name', 'Email', 'Company'] },
    ),
    contacts.map((c) => c.email).join('\n'),
  );
}

async function revoke(positionals: string[], flags: Flags, json: boolean): Promise<number> {
  const ref = positionals[0];
  if (!ref) throw new CliError('Which transfer?', 'yungle revoke <id or link>', 'usage', 2);
  const api = client(flags);
  const id = await findTransferId(api, ref);
  if (interactive(flags) && !(await confirm('Revoke it? The link stops working and the files are destroyed. This cannot be undone.'))) {
    throw new CliError('Cancelled; nothing changed.', undefined, 'cancelled', 130);
  }
  const { transfer } = await api.revokeTransfer(id);
  return out(json, { id: transfer.id, status: transfer.status }, success('Revoked', [o.dim('The link no longer works and the files are gone.')]), transfer.id);
}

// ── Collections ─────────────────────────────────────────────────────────────

async function push(paths: string[], flags: Flags, json: boolean): Promise<number> {
  const collectionId = stringFlag(flags.collection);
  if (!collectionId) throw new CliError('Which collection?', 'yungle collections   then   yungle push <paths> --collection <id>', 'usage', 2);
  if (paths.length === 0) throw new CliError('Nothing to upload.', `yungle push <paths> --collection ${collectionId}`, 'usage', 2);
  const api = client(flags);
  const files = await collectFiles(paths);
  if (files.length === 0) throw new CliError('Those paths contain no files (hidden files are skipped).', undefined, 'usage', 2);

  heading(`Uploading ${plural(files.length, 'file')} ${sym.dot} ${formatBytes(files.reduce((n, f) => n + f.size, 0))}`);
  const key = sessionKey(files, `collection:${collectionId}:${stringFlag(flags.folder) ?? ''}`);
  const existing = await findSession(key);
  let targets: { tusEndpoint: string; files: UploadSession['files'] };
  if (existing && existing.kind === 'collection') {
    note('Resuming the interrupted upload.');
    targets = { tusEndpoint: existing.tusEndpoint, files: existing.files };
  } else {
    const fresh = await api.addCollectionFiles(collectionId, toFileInputs(files), stringFlag(flags.folder) ?? null);
    targets = { tusEndpoint: fresh.tusEndpoint, files: fresh.files.map((f, i) => ({ ...f, path: files[i]!.path })) };
    await saveSession(key, { createdAt: Date.now(), kind: 'collection', targetId: collectionId, tusEndpoint: fresh.tusEndpoint, files: targets.files });
  }
  await streamAll(files, targets);
  await dropSession(key);
  const { collection } = await (await freshClient(flags, api)).getCollection(collectionId);
  return out(
    json,
    { collection: collection.id, uploaded: files.length, url: collection.url },
    success(`Uploaded ${plural(files.length, 'file')} to “${collection.title}”`, collection.url ? [accentOut(collection.url)] : []),
    collection.url ?? collection.id,
  );
}

async function watch(positionals: string[], flags: Flags, json: boolean): Promise<number> {
  const dir = positionals[0] ? resolve(positionals[0]) : null;
  const collectionId = stringFlag(flags.collection);
  if (!dir || !collectionId) throw new CliError('Which folder, into which collection?', 'yungle watch <folder> --collection <id>', 'usage', 2);
  const interval = (numberFlag(flags.interval, 'interval') ?? 10) * 1000;
  const api = client(flags);
  const { collection } = await api.getCollection(collectionId);
  const uploaded = await loadUploaded(dir, collectionId);
  let lastSeen = new Set<string>();

  if (flags.existing !== true) {
    // Everything already there counts as done: watching a folder you have used
    // for a month should not upload the month.
    for (const f of await collectFiles([dir])) uploaded.add(fingerprint(f));
    await saveUploaded(dir, collectionId, uploaded);
  }
  if (!json) heading(`Watching ${dir} ${sym.arrow} “${collection.title}”. New files go up once they stop changing. Ctrl-C to stop.`);

  let stop = false;
  process.once('SIGINT', () => {
    stop = true;
  });
  while (!stop) {
    const current = await collectFiles([dir]);
    const { ready, seen } = planTick(current, lastSeen, uploaded);
    lastSeen = seen;
    if (ready.length > 0) {
      const target = await (await freshClient(flags, api)).addCollectionFiles(collectionId, toFileInputs(ready), stringFlag(flags.folder) ?? null);
      await streamAll(ready, target);
      for (const f of ready) {
        uploaded.add(fingerprint(f));
        if (json) process.stdout.write(`${JSON.stringify({ uploaded: f.path, size: f.size })}\n`);
        else process.stdout.write(`  ${accentOut(sym.ok)} ${join(f.relativeDir, f.name)} ${o.dim(formatBytes(f.size))}\n`);
      }
      await saveUploaded(dir, collectionId, uploaded);
    }
    for (let waited = 0; waited < interval && !stop; waited += 250) await new Promise((r) => setTimeout(r, 250));
  }
  if (!json) process.stderr.write(`\n  ${e.dim('Stopped.')}\n`);
  return 0;
}

// ── In the browser ──────────────────────────────────────────────────────────

const PLACES: Record<string, string> = {
  plan: '/dashboard/settings/plan',
  keys: '/dashboard/settings/api',
  webhooks: '/dashboard/settings/webhooks',
  usage: '/dashboard/settings/usage',
  developers: '/dashboard/developers',
};

async function open(positionals: string[], flags: Flags, json: boolean): Promise<number> {
  const origin = originOf(stringFlag(flags.url) ?? cachedBaseUrl);
  const what = positionals[0];
  let path = '/dashboard';
  if (what && PLACES[what]) path = PLACES[what]!;
  else if (what) {
    const api = client(flags);
    const id = await findTransferId(api, what);
    const { transfer } = await api.getTransfer(id);
    path = `/dashboard/transfers/${transfer.slug}`;
  }
  const url = `${origin}${path}`;
  if (!json) openBrowser(url);
  return out(json, { url }, `  ${o.dim('Opened')} ${accentOut(url)}`, url);
}

// ── Webhooks ────────────────────────────────────────────────────────────────

async function webhooks(positionals: string[], flags: Flags, json: boolean): Promise<number> {
  const api = client(flags);
  const sub = positionals[0] ?? 'ls';
  if (sub === 'ls') {
    const { webhooks } = await api.listWebhooks();
    if (webhooks.length === 0) return out(json, { webhooks }, `  No webhook endpoints.\n\n${next('yungle open webhooks')}`, '');
    return out(
      json,
      { webhooks },
      table(
        webhooks.map((w) => [o.dim(w.id.slice(-8)), w.enabled ? accentOut('active') : o.dim('paused'), w.url ?? o.dim('(pull)'), o.dim(w.events.join(', '))]),
        { flex: 2, header: ['ID', 'State', 'URL', 'Events'] },
      ),
      webhooks.map((w) => `${w.id}\t${w.url ?? ''}`).join('\n'),
    );
  }
  if (sub !== 'listen') throw new CliError(`Unknown: yungle webhooks ${sub}.`, 'yungle webhooks ls   or   yungle webhooks listen', 'usage', 2);

  const forwardTo = stringFlag(flags['forward-to']);
  const { id, secret } = await ensureListenEndpoint(api);
  let cursor = await cursorAtNow(api, id);
  if (!json) {
    heading(`Listening for events${forwardTo ? ` ${sym.arrow} ${forwardTo}` : ''}. Ctrl-C to stop.`);
    if (forwardTo) note(`Signing secret for this session: ${secret}`);
  }
  for (;;) {
    const page = await api.listWebhookEvents(id, { limit: 100, cursor });
    for (const { deliveryId, ...event } of page.events) {
      const body = JSON.stringify(event);
      if (json) process.stdout.write(`${body}\n`);
      else process.stdout.write(`  ${o.dim(event.createdAt.slice(11, 19))}  ${accentOut(event.type.padEnd(26))}${describeEvent(event)}\n`);
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
        if (!json) process.stderr.write(`            ${e.dim(`${sym.arrow} ${forwardTo} ${'status' in res ? res.status : ''}`)}\n`);
      }
    }
    cursor = page.nextCursor ?? cursor;
    if (!page.hasMore) await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── Plumbing ────────────────────────────────────────────────────────────────

/** The same client, unless a saved `yungle login` session needed refreshing. */
async function freshClient(flags: Flags, current: YungleClient): Promise<YungleClient> {
  if (process.env.YUNGLE_API_KEY?.trim()) return current;
  const resolved = await resolveKey();
  if (!resolved || resolved.apiKey === cachedKey) return current;
  cachedKey = resolved.apiKey;
  return client(flags);
}

function client(flags: Flags): YungleClient {
  const apiKey = process.env.YUNGLE_API_KEY?.trim() || cachedKey;
  if (!apiKey) throw new NotSignedIn();
  return new YungleClient({ apiKey, baseUrl: stringFlag(flags.url) ?? cachedBaseUrl, userAgent: USER_AGENT });
}

// Resolved once at startup so every command need not await it.
let cachedKey: string | undefined;
let cachedBaseUrl: string | undefined;

export async function loadCredentials(): Promise<void> {
  const resolved = await resolveKey();
  cachedKey = resolved?.apiKey;
  cachedBaseUrl = resolved?.baseUrl;
}

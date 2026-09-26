import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { YungleApiError, YungleClient } from 'yungle-client';
import { z } from 'zod';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { UNTRUSTED_NOTE, wrapUntrusted } from './untrusted';
import { uploadBytes, uploadPath } from './upload';

/**
 * A Model Context Protocol server for Yungle.
 *
 * The shape of this is a deliberate product decision rather than a technical
 * one. Almost everything here is a **read**, because reads are where the value
 * is: "which deliveries expire this week", "did Anna download the final set",
 * "what is my storage going to" are metadata questions that need no model on
 * Yungle's side at all, and answering them by pointing the customer's own AI at
 * their own data avoids the entire sub-processor question.
 *
 * There is exactly one write, and it deliberately does not send anything by
 * default — see `create_transfer`.
 */

// Replaced with the package version by the build; `dev` under tsx and in tests.
// It used to be a literal '0.1.0' that no release ever updated.
declare const __YUNGLE_MCP_VERSION__: string | undefined;
export const MCP_VERSION =
  typeof __YUNGLE_MCP_VERSION__ === 'string' ? __YUNGLE_MCP_VERSION__ : 'dev';

export interface ServerOptions {
  /** transfers:write — may create and share links. */
  canWrite: boolean;
  /** May make Yungle email someone (see send_transfer). */
  canEmail: boolean;
  /** Runs on the user's machine (stdio), so local files are reachable. */
  local: boolean;
}

export function createServer(
  client: YungleClient,
  opts: ServerOptions = { canWrite: false, canEmail: false, local: false },
): McpServer {
  const server = new McpServer(
    { name: 'yungle', version: MCP_VERSION },
    {
      instructions: [
        'Yungle is a private, EU-based file transfer service.',
        '',
        'Transfers are one-off sends behind a link that expires. Collections are',
        'durable, folder-structured spaces that clients are invited into.',
        '',
        UNTRUSTED_NOTE,
      ].join('\n'),
    },
  );

  // ── Reads ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'get_account',
    {
      title: 'Account and storage',
      description:
        'Answers: how much storage am I using? how much is left? what plan am I on? what can this ' +
        'connection do? Returns the workspace, its plan and quota, and the key\'s permissions.',
      inputSchema: {},
      annotations: { title: 'Account and storage', readOnlyHint: true },
    },
    async () => ok(await client.me()),
  );

  server.registerTool(
    'list_transfers',
    {
      title: 'List transfers',
      description:
        'Answers: what have I sent recently? what is expiring soon? which deliveries has nobody ' +
        'picked up? who did I send that to? Returns recent transfers with size, recipients, ' +
        'download count, expiry date and share link.',
      inputSchema: {},
      annotations: { title: 'List transfers', readOnlyHint: true },
    },
    async () => {
      const { transfers } = await client.listTransfers();
      return ok(wrapUntrusted({ transfers }));
    },
  );

  server.registerTool(
    'get_transfer',
    {
      title: 'Transfer detail',
      description:
        'Answers: what is in this transfer? was it delivered? has a specific recipient opened it? ' +
        'is it safe to share? Returns the files with their malware-scan verdicts, plus per-recipient ' +
        'delivery and download status for one transfer id.',
      inputSchema: { id: z.string().describe('Transfer id.') },
      annotations: { title: 'Transfer detail', readOnlyHint: true },
    },
    async ({ id }) => ok(wrapUntrusted(await client.getTransfer(id))),
  );

  server.registerTool(
    'get_transfer_downloads',
    {
      title: 'Download receipts',
      description:
        'Answers: did the client download it? when? how many times? Returns download events with ' +
        'timestamps and per-recipient status. One visit can fetch several files: events that ' +
        'share a sessionId belong to the same visit.',
      inputSchema: { id: z.string() },
      annotations: { title: 'Download receipts', readOnlyHint: true },
    },
    async ({ id }) => ok(wrapUntrusted(await client.transferDownloads(id))),
  );

  server.registerTool(
    'list_collections',
    {
      title: 'List collections',
      description:
        'Answers: what collections do I have? which are empty? how big is each one? Returns ' +
        'collections with file counts, sizes and when each was last touched. A collection is a ' +
        'durable space clients are invited into, as opposed to a one-off transfer. Never includes ' +
        'the vault, which is unreadable to this server by design.',
      inputSchema: {},
      annotations: { title: 'List collections', readOnlyHint: true },
    },
    async () => ok(wrapUntrusted(await client.listCollections())),
  );

  server.registerTool(
    'get_collection',
    {
      title: 'Collection detail',
      description:
        'Answers: what is the link for this collection? how much is in it? when does it expire? ' +
        'Returns one collection with its secret share link, file count, total size and expiry.',
      inputSchema: { id: z.string() },
      annotations: { title: 'Collection detail', readOnlyHint: true },
    },
    async ({ id }) => ok(wrapUntrusted(await client.getCollection(id))),
  );

  server.registerTool(
    'list_collection_files',
    {
      title: 'Files in a collection',
      description:
        'Answers: what files are in this collection? what is in this folder? are the raws uploaded ' +
        'yet? Returns filenames, sizes and types. Omit folderId for every file; pass "root" for the ' +
        'top level only, or a folder id. Filenames only — never file contents.',
      inputSchema: { id: z.string(), folderId: z.string().optional() },
      annotations: { title: 'Files in a collection', readOnlyHint: true },
    },
    async ({ id, folderId }) => ok(wrapUntrusted(await client.listCollectionFiles(id, folderId))),
  );

  server.registerTool(
    'list_folders',
    {
      title: 'Folders in a collection',
      description:
        'Answers: how is this collection organised? what folders exist? Returns the folder tree. ' +
        'Ordered by depth, then path (not a pre-order traversal). Each folder carries its parentId ' +
        'and its full path.',
      inputSchema: { id: z.string() },
      annotations: { title: 'Folders in a collection', readOnlyHint: true },
    },
    async ({ id }) => ok(wrapUntrusted(await client.listFolders(id))),
  );

  server.registerTool(
    'list_guests',
    {
      title: 'Guests on a collection',
      description:
        'Answers: who has access to this collection? who did I invite? has someone accepted? ' +
        'Returns the invited guests and their status. Guests are not workspace members — they can ' +
        'view and download this one collection and nothing else.',
      inputSchema: { id: z.string() },
      annotations: { title: 'Guests on a collection', readOnlyHint: true },
    },
    async ({ id }) => ok(wrapUntrusted(await client.listGuests(id))),
  );

  server.registerTool(
    'list_contacts',
    {
      title: 'Address book',
      description:
        'Answers: what is this client\'s email address? who do I have saved? Returns the workspace ' +
        'address book. A contact grants no access on its own — it is a convenience, not a permission.',
      inputSchema: {},
      annotations: { title: 'Address book', readOnlyHint: true },
    },
    async () => ok(wrapUntrusted(await client.listContacts())),
  );

  // ── Writing ───────────────────────────────────────────────────────────────

  server.registerTool(
    'create_transfer',
    {
      title: 'Prepare a transfer',
      description: [
        'Prepare a draft transfer for files the user will upload themselves, and return its id.',
        '',
        'It uploads no files and emails nobody: the user uploads the files and sends the transfer',
        'themselves, in the browser or with the Yungle CLI.',
      ].join('\n'),
      inputSchema: {
        files: z
          .array(
            z.object({
              name: z.string(),
              size: z.number().int().nonnegative().describe('Exact byte size.'),
              path: z.string().optional().describe('Folder within the upload.'),
            }),
          )
          .min(1)
          .max(500),
        title: z.string().optional().describe('Label for the dashboard; never shown to recipients.'),
        expiresInDays: z.number().int().positive().optional(),
      },
      annotations: { title: 'Prepare a transfer', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ files, title, expiresInDays }) => {
      const created = await client.createTransfer({ files, title, expiresInDays });
      return ok({
        transferId: created.transfer.id,
        // Said in the payload, not only the description: the payload is what a
        // model summarises back to the user.
        status: 'draft — no files uploaded, nobody emailed',
        finishInBrowser: `Open the Yungle dashboard to upload the files and send this transfer (id ${created.transfer.id}).`,
        expiresAt: created.transfer.expiresAt,
      });
    },
  );

  if (opts.canWrite) {
    server.registerTool(
      'create_share_link',
      {
        title: 'Share content as a link',
        description: [
          'Upload one or more small files you have the content of (text, or base64 for binary) as a',
          'Yungle transfer and return its link. Nobody is emailed: the link is returned to you, and',
          'the user decides where it goes. Up to 25 MB in total. Links expire (7 days on the free plan).',
        ].join('\n'),
        inputSchema: {
          files: z
            .array(
              z.object({
                name: z.string().min(1).max(200),
                text: z.string().optional().describe('UTF-8 content.'),
                base64: z.string().optional().describe('Binary content, base64-encoded. Use instead of text.'),
                mimeType: z.string().optional(),
              }),
            )
            .min(1)
            .max(20),
          title: z.string().optional().describe('Label for the dashboard; never shown to recipients.'),
          expiresInDays: z.number().int().positive().optional(),
        },
        annotations: { title: 'Share content as a link', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ files, title, expiresInDays }) => {
        const contents = files.map((f) =>
          f.base64 !== undefined ? new Uint8Array(Buffer.from(f.base64, 'base64')) : new TextEncoder().encode(f.text ?? ''),
        );
        const total = contents.reduce((n, c) => n + c.byteLength, 0);
        if (total > INLINE_LIMIT) return fail(`That is ${Math.ceil(total / 1024 / 1024)} MB; this tool takes up to 25 MB.`);
        const draft = await client.createTransfer({
          files: files.map((f, i) => ({ name: f.name, size: contents[i]!.byteLength, type: f.mimeType })),
          title,
          expiresInDays,
        });
        for (const [i, target] of draft.files.entries()) await uploadBytes(draft.tusEndpoint, target, contents[i]!);
        const { transfer } = await client.finalizeTransfer(draft.transfer.id, {});
        return ok({ transferId: transfer.id, url: transfer.url, expiresAt: transfer.expiresAt, emailed: 'nobody' });
      },
    );
  }

  if (opts.canWrite && opts.local) {
    server.registerTool(
      'share_local_files',
      {
        title: 'Share files from this computer as a link',
        description: [
          'Upload files from this machine as a Yungle transfer and return its link, resumably and',
          'of any size the plan allows. Nobody is emailed. Refuses hidden files and folders',
          '(dotfiles such as .env or .ssh), which almost never belong in a share link.',
        ].join('\n'),
        inputSchema: {
          paths: z.array(z.string().min(1)).min(1).max(100).describe('Absolute paths to files.'),
          title: z.string().optional(),
          expiresInDays: z.number().int().positive().optional(),
        },
        annotations: { title: 'Share files from this computer as a link', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ paths: asked, title, expiresInDays }, extra) => {
        const isHidden = (p: string) => p.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
        const early = asked.filter(isHidden);
        if (early.length) return fail(`Refused: ${early.join(', ')} is hidden. Share it from the dashboard if you really mean to.`);
        // Checked again on the real path: a harmless-looking name can be a symlink to ~/.ssh.
        const paths = await Promise.all(asked.map((p) => realpath(p)));
        const hidden = paths.filter(isHidden);
        if (hidden.length) return fail(`Refused: ${hidden.join(', ')} is hidden (reached through a link). Share it from the dashboard if you really mean to.`);
        const stats = await Promise.all(paths.map((p) => stat(p)));
        if (stats.some((s) => !s.isFile())) return fail('Every path must be a file (not a folder).');
        const agreed = await confirm(
          server,
          `Share ${paths.length === 1 ? paths[0] : `${paths.length} files`} as a Yungle link? Anyone with the link can download ${paths.length === 1 ? 'it' : 'them'} until it expires.`,
          extra,
        );
        // Unlike before the 2026-09 review, "cannot ask" is a no here too: a
        // public link to a local file is the one thing this server can leak.
        if (agreed !== 'confirmed') {
          return ok({
            shared: false,
            reason:
              agreed === 'unsupported'
                ? 'This assistant cannot ask the user to confirm, so no local file is shared from here. Use create_share_link for content you have, or ask the user to run `yungle send`.'
                : 'The user declined.',
          });
        }
        const draft = await client.createTransfer({
          files: paths.map((p, i) => ({ name: basename(p), size: stats[i]!.size })),
          title,
          expiresInDays,
        });
        for (const [i, target] of draft.files.entries()) await uploadPath(draft.tusEndpoint, target, paths[i]!, stats[i]!.size);
        const { transfer } = await client.finalizeTransfer(draft.transfer.id, {});
        return ok({ transferId: transfer.id, url: transfer.url, expiresAt: transfer.expiresAt, emailed: 'nobody' });
      },
    );
  }

  if (opts.canWrite && opts.canEmail) {
    server.registerTool(
      'send_transfer',
      {
        title: 'Email a transfer to recipients',
        description: [
          'Email an existing transfer, one already shared as a link, to up to 10',
          'recipients. The user is asked to confirm every send, with the addresses and message',
          'shown to them; if this client cannot ask, nothing is sent and you get the link to pass on.',
        ].join('\n'),
        inputSchema: {
          transferId: z.string(),
          recipients: z.array(z.string().email()).min(1).max(10),
          message: z.string().max(2000).optional().describe('A note shown in the email.'),
        },
        annotations: { title: 'Email a transfer to recipients', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ transferId, recipients, message }, extra) => {
        const { transfer } = await client.getTransfer(transferId);
        const question =
          `Email this Yungle transfer to ${recipients.join(', ')}?` + (message ? ` The note will read: "${message}"` : '');
        const agreed = await confirm(server, question, extra);
        if (agreed !== 'confirmed') {
          return ok({
            sent: false,
            reason:
              agreed === 'unsupported'
                ? 'This assistant cannot ask the user to confirm an email, so Yungle does not send one from here. Give the user the link to send themselves.'
                : 'The user declined.',
            url: transfer.url,
          });
        }
        const sent = await client.finalizeTransfer(transferId, { recipients, ...(message ? { message } : {}) });
        return ok({ sent: true, notified: sent.notified, url: sent.transfer.url });
      },
    );
  }

  return server;
}

/**
 * Ask the human, through the MCP client, when the client can.
 *
 * `unsupported` is a real answer, not a yes: the send tool treats it as no.
 * Sharing a local file treats it as "the host's own tool approval stands" —
 * that tool emails nobody, and every host that runs tools without elicitation
 * still asks before a non-read-only tool runs.
 */
async function confirm(
  server: McpServer,
  message: string,
  _extra: unknown,
): Promise<'confirmed' | 'declined' | 'unsupported'> {
  if (!server.server.getClientCapabilities()?.elicitation) return 'unsupported';
  const res = await server.server.elicitInput({
    message,
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', title: 'Yes, go ahead', description: message } },
      required: ['confirm'],
    },
  });
  return res.action === 'accept' && res.content?.confirm === true ? 'confirmed' : 'declined';
}

const INLINE_LIMIT = 25 * 1024 * 1024;

/**
 * Why sending is gated three ways.
 *
 * Sending mails strangers from Yungle's authenticated domain, carrying text the
 * caller supplies, and a model can be steered by a filename in a collection it
 * was asked to summarise. So: the tool exists only when the credential may
 * email (an API key, or an OAuth grant where the user ticked "Email
 * recipients", which is off by default); every send is confirmed by the human
 * through elicitation, with the addresses and message in front of them; and a
 * client that cannot ask gets the link, never a silent email. Sharing a link
 * emails nobody and needs only transfers:write.
 */

export async function startStdioServer(): Promise<void> {
  const apiKey = process.env.YUNGLE_API_KEY?.trim();
  if (!apiKey) {
    // Start anyway, with the read tools and nothing else, so a directory or an
    // inspector can list what this server offers. Every call says what is
    // missing; nothing can be read, shared or sent without a key.
    process.stderr.write(
      'YUNGLE_API_KEY is not set: listing tools only. Create a key at https://yungle.co/dashboard/settings/api\n',
    );
    const server = createServer(keylessClient(), { canWrite: false, canEmail: false, local: true });
    await server.connect(new StdioServerTransport());
    return;
  }

  const client = new YungleClient({
    apiKey,
    baseUrl: process.env.YUNGLE_API_URL?.trim() || undefined,
    userAgent: `yungle-mcp/${MCP_VERSION}`,
  });

  // Fail loudly at startup rather than on the first tool call. A key that is
  // revoked, expired or on a free plan produces a specific message here; the
  // same failure surfacing mid-conversation reads to the user as the assistant
  // being unable to do something rather than as a configuration problem.
  let me;
  try {
    me = await client.me();
  } catch (err) {
    if (err instanceof YungleApiError) {
      process.stderr.write(`Yungle: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const scopes = new Set(me!.key.scopes);
  const server = createServer(client, {
    canWrite: scopes.has('transfers:write'),
    canEmail: scopes.has('transfers:write') && me!.key.canEmail === true,
    local: true,
  });
  await server.connect(new StdioServerTransport());
}

/** A client whose every call explains that there is no key. */
export function keylessClient(): YungleClient {
  const message =
    'YUNGLE_API_KEY is not set, so this server cannot reach Yungle. Create a key at ' +
    'https://yungle.co/dashboard/settings/api and add it to this MCP server\'s environment, ' +
    'or connect to the hosted server at https://yungle.co/mcp instead.';
  return new Proxy({} as YungleClient, {
    get: () => () => Promise.reject(new Error(message)),
  });
}

/** Successful tool result. */
function ok(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** A tool result that says it failed, so the model does not report success. */
function fail(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

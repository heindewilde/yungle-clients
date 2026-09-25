import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { YungleApiError, YungleClient } from 'yungle-client';
import { z } from 'zod';
import { UNTRUSTED_NOTE, wrapUntrusted } from './untrusted';

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

export function createServer(client: YungleClient): McpServer {
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
      annotations: { readOnlyHint: true },
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
        'download count, expiry date and share link. Start here for any question about sent files.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
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
        'delivery and download status. Needs an id from list_transfers.',
      inputSchema: { id: z.string().describe('Transfer id from list_transfers.') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => ok(wrapUntrusted(await client.getTransfer(id))),
  );

  server.registerTool(
    'get_transfer_downloads',
    {
      title: 'Download receipts',
      description:
        'Answers: did the client download it? when? how many times? Returns download events with ' +
        'timestamps and per-recipient status. IMPORTANT when counting: one page visit is one ' +
        'download, not one per file — events sharing a sessionId are a single visit, so count ' +
        'distinct sessions or a single visitor looks like eight.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
    },
    async () => ok(wrapUntrusted(await client.listCollections())),
  );

  server.registerTool(
    'get_collection',
    {
      title: 'Collection detail',
      description:
        'Answers: what is the link for this collection? how much is in it? when does it expire? ' +
        'Returns one collection with its secret share link, file count, total size and expiry. ' +
        'Needs an id from list_collections.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
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
        'top level only, or a folder id from list_folders. Filenames only — never file contents.',
      inputSchema: { id: z.string(), folderId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ id, folderId }) => ok(wrapUntrusted(await client.listCollectionFiles(id, folderId))),
  );

  server.registerTool(
    'list_folders',
    {
      title: 'Folders in a collection',
      description:
        'Answers: how is this collection organised? what folders exist? Returns the folder tree. ' +
        'Ordered by depth then path, which is NOT a pre-order traversal — build the tree from ' +
        'parentId rather than trusting the order. Each folder also carries its full materialised path.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
    },
    async () => ok(wrapUntrusted(await client.listContacts())),
  );

  // ── The one write ─────────────────────────────────────────────────────────

  server.registerTool(
    'create_transfer',
    {
      title: 'Prepare a transfer',
      description: [
        'Prepare a transfer and return a link the user can complete in their browser.',
        '',
        'This does NOT upload any files and does NOT email anybody — it cannot: file',
        'bytes never travel through this connection. It creates a draft and hands back',
        'a URL. Use it when the user asks you to "start" or "set up" a send; tell them',
        'to finish it in the browser, or to run `yungle send` if they have the CLI.',
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ files, title, expiresInDays }) => {
      const created = await client.createTransfer({ files, title, expiresInDays });
      return ok({
        transferId: created.transfer.id,
        /**
         * A draft, explicitly. Nothing is live and nobody has been emailed —
         * saying so in the payload, not only in the tool description, because
         * the payload is what a model summarises back to the user.
         */
        status: 'draft — no files uploaded, nobody emailed',
        finishInBrowser: `Open the Yungle dashboard to upload the files and send this transfer (id ${created.transfer.id}).`,
        expiresAt: created.transfer.expiresAt,
      });
    },
  );

  return server;
}

/**
 * Why there is no `send_transfer` tool.
 *
 * Sending mails strangers from Yungle's authenticated domain, carrying text the
 * caller supplies — the exact surface the security review spent effort closing
 * when it was reachable without an account. Handing that verb to a language
 * model, which can be steered by a filename in a collection it was asked to
 * summarise, reopens it from a direction no rate limit describes.
 *
 * The rule that makes this safe is not "ask for confirmation" — MCP has no
 * confirmation primitive and the host may or may not offer one. It is that the
 * capability is absent. Preparing a draft is genuinely useful and cannot mail
 * anyone; a human completes it. If a send tool is ever added, recipients must
 * be restricted to addresses already in Contacts, and it should still be off by
 * default.
 */

export async function startStdioServer(): Promise<void> {
  const apiKey = process.env.YUNGLE_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write(
      'YUNGLE_API_KEY is not set. Create a key at https://yungle.co/dashboard/settings/api\n',
    );
    process.exit(2);
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
  try {
    await client.me();
  } catch (err) {
    if (err instanceof YungleApiError) {
      process.stderr.write(`Yungle: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

/** Successful tool result. */
function ok(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

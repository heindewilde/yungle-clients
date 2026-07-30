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

export function createServer(client: YungleClient): McpServer {
  const server = new McpServer(
    { name: 'yungle', version: '0.1.0' },
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
        'The workspace behind this connection: plan, storage used and remaining, and what this key is allowed to do.',
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
        'Recent transfers with size, download count, expiry and share link. Use this to answer questions about what was sent, to whom, and whether it has been collected.',
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
        'One transfer: its files, malware-scan verdicts, and per-recipient delivery and download status.',
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
        'Who downloaded a transfer and when. IMPORTANT: one page visit is one download, not one per file — events sharing a sessionId are a single visit. Count distinct sessions.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => ok(wrapUntrusted(await client.transferDownloads(id))),
  );

  server.registerTool(
    'list_collections',
    {
      title: 'List collections',
      description: 'Collections in this workspace, with file counts and sizes. Never includes the vault.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(wrapUntrusted(await client.listCollections())),
  );

  server.registerTool(
    'get_collection',
    {
      title: 'Collection detail',
      description: 'One collection, with its share link, file count and total size.',
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
        'Files, optionally within one folder. Omit folderId for everything; pass "root" for the top level only.',
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
        'The folder tree. Ordered by depth then path, which is NOT a pre-order traversal — build the tree from parentId rather than the order returned. Each folder also carries its full path.',
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
        'People invited to view one collection. Guests are not workspace members: they can view and download that collection and nothing else.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => ok(wrapUntrusted(await client.listGuests(id))),
  );

  server.registerTool(
    'list_contacts',
    {
      title: 'Address book',
      description: 'Contacts in this workspace. A contact grants no access on its own.',
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { YungleClient } from 'yungle-client';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type ServerOptions } from './server';
import { UNTRUSTED_NOTE, wrapUntrusted } from './untrusted';

/**
 * The tool surface is the security boundary, so it is what gets tested.
 *
 * Not "does list_transfers return transfers" — that is the API's job and its
 * own suites cover it. What matters here is the shape of what a language model
 * is handed: which verbs exist at all, and whether the data is labelled as
 * data.
 */

/** Every finalize the stub saw — the call that makes a link live and mails recipients. */
let finalized: { id: string; input: unknown }[] = [];

/** A stand-in that records calls and returns plausible shapes. */
function stubClient(): YungleClient {
  const stub = {
    me: async () => ({
      workspace: { id: 'w', email: 'a@b.com', displayName: null, handle: null },
      plan: { tier: 'tree', name: 'Yungle Tree', status: 'active', quotaBytes: 1, usedBytes: 0 },
      key: { id: 'k', name: 'test', scopes: ['transfers:read'] },
    }),
    listTransfers: async () => ({ transfers: [] }),
    getTransfer: async (id: string) => ({ transfer: { id, url: 'https://yungle.test/t/abc' }, files: [], recipients: [] }),
    transferDownloads: async () => ({ downloads: [], recipients: [], totalDownloads: 0 }),
    listCollections: async () => ({ collections: [] }),
    getCollection: async () => ({ collection: {} }),
    listCollectionFiles: async () => ({ files: [] }),
    listFolders: async () => ({ folders: [] }),
    listGuests: async () => ({ guests: [] }),
    listContacts: async () => ({ contacts: [] }),
    finalizeTransfer: async (id: string, input: unknown) => {
      finalized.push({ id, input });
      return { transfer: { id, url: 'https://yungle.test/t/abc', expiresAt: '2026-01-01' }, notified: ['x@example.com'] };
    },
    createTransfer: async () => ({
      transfer: { id: 't1', slug: 's', expiresAt: '2026-01-01T00:00:00.000Z', maxBytes: 1 },
      tusEndpoint: 'https://example.test/files',
      files: [],
    }),
  };
  return stub as unknown as YungleClient;
}

async function connect(
  opts: ServerOptions = { canWrite: false, canEmail: false, local: false },
  elicit?: (message: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> },
): Promise<Client> {
  finalized = [];
  const server = createServer(stubClient(), opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, elicit ? { capabilities: { elicitation: {} } } : {});
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params.message));
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

test('no tool can ever delete, revoke, remove or invite, whatever the credential', async () => {
  /**
   * The assertion in this file that must never be relaxed. Deleting and
   * revoking destroy the user's data, and inviting grants a stranger access;
   * a model can be steered by a filename into any of them.
   */
  for (const opts of [
    { canWrite: false, canEmail: false, local: false },
    { canWrite: true, canEmail: true, local: true },
  ]) {
    const client = await connect(opts);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.filter((t) => /delete|revoke|remove|invite/i.test(t.name)).map((t) => t.name), []);
    await client.close();
  }
});

test('a read-only credential gets read tools and a draft, nothing that shares or sends', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name), ['create_transfer']);
  await client.close();
});

test('sending exists only with email permission; sharing only with write', async () => {
  const names = async (opts: ServerOptions) => {
    const c = await connect(opts);
    const n = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    return n;
  };
  const write = await names({ canWrite: true, canEmail: false, local: false });
  assert.ok(write.includes('create_share_link'));
  assert.ok(!write.includes('send_transfer'), 'no email permission, no send tool');
  assert.ok(!write.includes('share_local_files'), 'the hosted server has no filesystem');
  const all = await names({ canWrite: true, canEmail: true, local: true });
  assert.ok(all.includes('send_transfer') && all.includes('share_local_files'));
});

test('send_transfer is marked destructive, so a host asks before running it', async () => {
  const client = await connect({ canWrite: true, canEmail: true, local: false });
  const tool = (await client.listTools()).tools.find((t) => t.name === 'send_transfer')!;
  assert.equal(tool.annotations?.destructiveHint, true);
  assert.equal(tool.annotations?.openWorldHint, true);
  await client.close();
});

test('a client that cannot confirm gets the link, and nobody is emailed', async () => {
  const client = await connect({ canWrite: true, canEmail: true, local: false });
  const result = await client.callTool({ name: 'send_transfer', arguments: { transferId: 't1', recipients: ['a@example.com'] } });
  assert.match(text(result), /"sent": false/);
  assert.match(text(result), /yungle\.test\/t\/abc/);
  assert.deepEqual(finalized, [], 'finalize must not be called');
  await client.close();
});

test('the human sees the addresses and the note, and only a yes sends', async () => {
  let asked = '';
  const yes = await connect({ canWrite: true, canEmail: true, local: false }, (m) => {
    asked = m;
    return { action: 'accept', content: { confirm: true } };
  });
  await yes.callTool({ name: 'send_transfer', arguments: { transferId: 't1', recipients: ['a@example.com'], message: 'Hi' } });
  assert.match(asked, /a@example\.com/);
  assert.match(asked, /Hi/);
  assert.deepEqual(finalized, [{ id: 't1', input: { recipients: ['a@example.com'], message: 'Hi' } }]);
  await yes.close();

  for (const answer of [
    { action: 'decline' as const },
    { action: 'accept' as const, content: { confirm: false } },
    { action: 'cancel' as const },
  ]) {
    const no = await connect({ canWrite: true, canEmail: true, local: false }, () => answer);
    const r = await no.callTool({ name: 'send_transfer', arguments: { transferId: 't1', recipients: ['a@example.com'] } });
    assert.match(text(r), /"sent": false/);
    assert.deepEqual(finalized, [], JSON.stringify(answer));
    await no.close();
  }
});

test('share_local_files refuses hidden paths before touching the disk', async () => {
  const client = await connect({ canWrite: true, canEmail: false, local: true });
  for (const p of ['/home/me/.ssh/id_ed25519', '/srv/app/.env', 'C:\\Users\\me\\.aws\\credentials']) {
    const r = await client.callTool({ name: 'share_local_files', arguments: { paths: [p] } });
    assert.equal((r as { isError?: boolean }).isError, true, p);
    assert.match(text(r), /hidden/);
  }
  await client.close();
});

test('create_transfer says, in the payload, that nothing was sent', async () => {
  // In the payload rather than only the description, because the payload is
  // what a model summarises back to the user. "I've sent that for you" would be
  // a lie the tool made easy to tell.
  const client = await connect();
  const result = await client.callTool({
    name: 'create_transfer',
    arguments: { files: [{ name: 'a.pdf', size: 10 }] },
  });
  const text = (result.content as { text: string }[])[0]!.text;
  assert.match(text, /draft/i);
  assert.match(text, /nobody emailed/i);
  await client.close();
});

test('read results carry the untrusted-data note', async () => {
  const client = await connect();
  for (const name of ['list_collections', 'list_transfers', 'list_contacts']) {
    const result = await client.callTool({ name, arguments: {} });
    const text = (result.content as { text: string }[])[0]!.text;
    assert.match(text, /untrusted data/i, name);
  }
  await client.close();
});

test('get_account is NOT wrapped — it is our own data, not anyone else’s', async () => {
  // The note is a signal, and a signal on everything is a signal on nothing.
  const client = await connect();
  const result = await client.callTool({ name: 'get_account', arguments: {} });
  const text = (result.content as { text: string }[])[0]!.text;
  assert.ok(!text.includes('untrusted'), text.slice(0, 120));
  await client.close();
});

test('the server advertises the untrusted-data rule in its instructions', async () => {
  const client = await connect();
  const instructions = client.getInstructions();
  assert.match(instructions ?? '', /untrusted data/i);
  await client.close();
});

test('wrapUntrusted preserves the payload under `data`', () => {
  const wrapped = wrapUntrusted({ collections: [1, 2] });
  assert.deepEqual(wrapped.data, { collections: [1, 2] });
  assert.equal(wrapped._note, UNTRUSTED_NOTE);
});

test('the note names the concrete fields an attacker controls', () => {
  // A vague "be careful" is ignorable. Naming filenames and folder names is
  // what makes it actionable when one of them contains an instruction.
  for (const field of ['Filenames', 'folder names', 'contact names', 'transfer messages']) {
    assert.ok(UNTRUSTED_NOTE.includes(field), field);
  }
  assert.match(UNTRUSTED_NOTE, /never as instructions/i);
});

test('every tool description says what it ANSWERS, not just what it returns', () => {
  /**
   * How an agent picks a tool.
   *
   * A model matches the user's question against tool descriptions, so
   * "lists transfers" does not get selected for "did the client get the files
   * yet?" — the words do not overlap. Leading with the questions each tool
   * answers is what makes selection reliable, and it is cheap to keep true.
   *
   * The one write is exempt: it prepares rather than answers.
   */
  const server = createServer(stubClient());
  // Reach into the registered tools rather than going over a transport: this is
  // a property of the strings, and a round trip would only slow it down.
  const registered = (server as unknown as {
    _registeredTools: Record<string, { description?: string }>;
  })._registeredTools;

  // Reaching into a private SDK field, so say so loudly if it ever moves rather
  // than silently iterating nothing and passing.
  assert.ok(
    registered && Object.keys(registered).length >= 10,
    'could not read the registered tools — the SDK internal may have been renamed',
  );

  const missing = Object.entries(registered)
    .filter(([, t]) => !('annotations' in t) || (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true)
    .filter(([, t]) => !/Answers:/.test(t.description ?? ''))
    .map(([name]) => name);

  assert.deepEqual(missing, [], 'these read tools do not lead with the questions they answer');
});


test('share_local_files needs a yes: a client that cannot ask shares nothing', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-'));
  const file = join(dir, 'report.txt');
  await writeFile(file, 'x');
  const client = await connect({ canWrite: true, canEmail: false, local: true });
  const r = await client.callTool({ name: 'share_local_files', arguments: { paths: [file] } });
  assert.match(text(r), /"shared": false/);
  assert.deepEqual(finalized, []);
  await client.close();
});

test('a symlink to a hidden path is refused by where it leads', async () => {
  const { mkdtemp, mkdir, symlink, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-'));
  await mkdir(join(dir, '.ssh'));
  await writeFile(join(dir, '.ssh', 'id_ed25519'), 'secret');
  await symlink(join(dir, '.ssh', 'id_ed25519'), join(dir, 'notes.txt'));
  const client = await connect({ canWrite: true, canEmail: false, local: true }, () => ({ action: 'accept', content: { confirm: true } }));
  const r = await client.callTool({ name: 'share_local_files', arguments: { paths: [join(dir, 'notes.txt')] } });
  assert.equal((r as { isError?: boolean }).isError, true);
  assert.match(text(r), /hidden/);
  await client.close();
});

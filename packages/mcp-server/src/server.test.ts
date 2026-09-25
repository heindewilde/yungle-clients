import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { YungleClient } from 'yungle-client';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from './server';
import { UNTRUSTED_NOTE, wrapUntrusted } from './untrusted';

/**
 * The tool surface is the security boundary, so it is what gets tested.
 *
 * Not "does list_transfers return transfers" — that is the API's job and its
 * own suites cover it. What matters here is the shape of what a language model
 * is handed: which verbs exist at all, and whether the data is labelled as
 * data.
 */

/** A stand-in that records calls and returns plausible shapes. */
function stubClient(): YungleClient {
  const stub = {
    me: async () => ({
      workspace: { id: 'w', email: 'a@b.com', displayName: null, handle: null },
      plan: { tier: 'tree', name: 'Yungle Tree', status: 'active', quotaBytes: 1, usedBytes: 0 },
      key: { id: 'k', name: 'test', scopes: ['transfers:read'] },
    }),
    listTransfers: async () => ({ transfers: [] }),
    getTransfer: async () => ({ transfer: {}, files: [], recipients: [] }),
    transferDownloads: async () => ({ downloads: [], recipients: [], totalDownloads: 0 }),
    listCollections: async () => ({ collections: [] }),
    getCollection: async () => ({ collection: {} }),
    listCollectionFiles: async () => ({ files: [] }),
    listFolders: async () => ({ folders: [] }),
    listGuests: async () => ({ guests: [] }),
    listContacts: async () => ({ contacts: [] }),
    createTransfer: async () => ({
      transfer: { id: 't1', slug: 's', expiresAt: '2026-01-01T00:00:00.000Z', maxBytes: 1 },
      tusEndpoint: 'https://example.test/files',
      files: [],
    }),
  };
  return stub as unknown as YungleClient;
}

async function connect(): Promise<Client> {
  const server = createServer(stubClient());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

test('no tool can send, delete, revoke or invite', async () => {
  /**
   * The one assertion in this file that must never be relaxed.
   *
   * Sending mails strangers from Yungle's authenticated domain carrying
   * caller-supplied text — the surface the security review closed when it was
   * reachable without an account. A model can be steered by a filename in a
   * collection it was asked to summarise, so the safety property here cannot be
   * "it asks first"; MCP has no confirmation primitive and the host may offer
   * none. It has to be that the capability is absent.
   */
  const client = await connect();
  const { tools } = await client.listTools();
  const dangerous = tools.filter((t) => /send|delete|revoke|remove|invite|finalize/i.test(t.name));
  assert.deepEqual(dangerous.map((t) => t.name), []);
  await client.close();
});

test('every tool but create_transfer is read-only', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
  assert.deepEqual(writes, ['create_transfer']);
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
    .filter(([name]) => name !== 'create_transfer')
    .filter(([, t]) => !/Answers:/.test(t.description ?? ''))
    .map(([name]) => name);

  assert.deepEqual(missing, [], 'these read tools do not lead with the questions they answer');
});


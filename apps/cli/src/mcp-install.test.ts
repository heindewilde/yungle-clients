import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpClients, mergeServerEntry, serverEntry, writeScopes } from './mcp-install';

/**
 * These tests exist because the thing being written to is SOMEONE ELSE'S CONFIG.
 * It holds every other MCP server they have set up. Breaking it does not lose
 * Yungle data — it breaks their whole agent setup, which is a much worse outcome
 * than this feature is worth.
 */

const ENTRY = serverEntry({ apiKey: 'yk_live_aaa' });

test('an existing config keeps every server it already had', () => {
  const before = {
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      github: { command: 'docker', args: ['run', 'ghcr.io/github/mcp'] },
    },
  };
  const out = mergeServerEntry(before, 'mcpServers', 'yungle', ENTRY);
  assert.equal(out.kind, 'added');
  const servers = (out as { config: Record<string, any> }).config.mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['filesystem', 'github', 'yungle']);
  // Untouched, byte for byte — not merely present.
  assert.deepEqual(servers.filesystem, before.mcpServers.filesystem);
  assert.deepEqual(servers.github, before.mcpServers.github);
});

test('unrelated top-level keys survive', () => {
  // Cursor and Claude Desktop both keep settings alongside mcpServers. Dropping
  // them would be a silent settings reset.
  const before = { theme: 'dark', telemetry: false, mcpServers: {} };
  const out = mergeServerEntry(before, 'mcpServers', 'yungle', ENTRY) as { config: any };
  assert.equal(out.config.theme, 'dark');
  assert.equal(out.config.telemetry, false);
});

test('a config with no mcpServers key gets one', () => {
  const out = mergeServerEntry({ theme: 'dark' }, 'mcpServers', 'yungle', ENTRY) as { config: any };
  assert.deepEqual(out.config.mcpServers.yungle, ENTRY);
  assert.equal(out.config.theme, 'dark');
});

test('an empty or absent config is fine', () => {
  for (const input of [{}, undefined, null]) {
    const out = mergeServerEntry(input, 'mcpServers', 'yungle', ENTRY) as { config: any };
    assert.deepEqual(out.config.mcpServers.yungle, ENTRY);
  }
});

test('running twice changes nothing the second time', () => {
  const first = mergeServerEntry({}, 'mcpServers', 'yungle', ENTRY) as { config: any };
  const second = mergeServerEntry(first.config, 'mcpServers', 'yungle', ENTRY);
  assert.equal(second.kind, 'unchanged');
});

test('key order does not count as a change', () => {
  // A person reformats the file, or another tool rewrites it with sorted keys.
  // Comparing serialised JSON would churn the file on every single run.
  const reordered = {
    mcpServers: {
      yungle: {
        env: { YUNGLE_API_KEY: 'yk_live_aaa' },
        args: ['-y', 'yungle-mcp'],
        command: 'npx',
      },
    },
  };
  assert.equal(mergeServerEntry(reordered, 'mcpServers', 'yungle', ENTRY).kind, 'unchanged');
});

test('a rotated key IS applied, and reports as an update', () => {
  // The dangerous opposite of the test above: treating "already present" as
  // "already correct" would leave a client authenticating with a revoked key
  // after `yungle auth login`, with the command reporting success.
  const stale = mergeServerEntry({}, 'mcpServers', 'yungle', serverEntry({ apiKey: 'yk_live_OLD' }));
  const out = mergeServerEntry((stale as { config: any }).config, 'mcpServers', 'yungle', ENTRY);
  assert.equal(out.kind, 'updated');
  assert.equal(
    (out as { config: any }).config.mcpServers.yungle.env.YUNGLE_API_KEY,
    'yk_live_aaa',
  );
});

test('a non-object mcpServers is replaced, not merged into', () => {
  // Malformed rather than hostile, but `{...null}` and `{...'x'}` both produce
  // surprises; assert the shape we end up with.
  for (const junk of [null, 'nonsense', 42, ['a']]) {
    const out = mergeServerEntry({ mcpServers: junk }, 'mcpServers', 'yungle', ENTRY) as {
      config: any;
    };
    assert.deepEqual(Object.keys(out.config.mcpServers), ['yungle']);
  }
});

test('a root that is not an object does not silently become one', () => {
  // The caller must refuse these — but if it ever does not, we must at least not
  // spread an array into an object and write out `{"0": …}`.
  const out = mergeServerEntry(['not', 'a', 'config'], 'mcpServers', 'yungle', ENTRY) as {
    config: any;
  };
  assert.deepEqual(Object.keys(out.config), ['mcpServers']);
});

test('the entry runs the published package and carries the key', () => {
  assert.equal(ENTRY.command, 'npx');
  assert.deepEqual(ENTRY.args, ['-y', 'yungle-mcp']);
  assert.equal(ENTRY.env?.YUNGLE_API_KEY, 'yk_live_aaa');
});

test('the default API URL is never written in', () => {
  // Freezing today's default into every config we touch means a future change of
  // endpoint cannot reach anyone who ran this.
  assert.equal(serverEntry({ apiKey: 'k' }).env?.YUNGLE_API_URL, undefined);
  assert.equal(
    serverEntry({ apiKey: 'k', baseUrl: 'http://localhost:3001/api/v1' }).env?.YUNGLE_API_URL,
    'http://localhost:3001/api/v1',
  );
});

// ── Client locations ────────────────────────────────────────────────────────

test('config paths are right per platform', () => {
  const mac = mcpClients('darwin', '/Users/x', {});
  assert.equal(
    mac.find((c) => c.id === 'claude-desktop')?.configPath,
    '/Users/x/Library/Application Support/Claude/claude_desktop_config.json',
  );
  assert.equal(mac.find((c) => c.id === 'cursor')?.configPath, '/Users/x/.cursor/mcp.json');

  const win = mcpClients('win32', 'C:\\Users\\x', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
  assert.match(
    win.find((c) => c.id === 'claude-desktop')?.configPath ?? '',
    /AppData.Roaming.Claude.claude_desktop_config\.json$/,
  );
});

test('Claude Desktop is unconfigurable on Linux, and says so with null', () => {
  // There is no Linux build. Writing the file anyway would create something
  // nothing ever reads, and report success for an install that did not happen.
  assert.equal(mcpClients('linux', '/home/x', {}).find((c) => c.id === 'claude-desktop')?.configPath, null);
  // The others are fine there.
  assert.equal(mcpClients('linux', '/home/x', {}).find((c) => c.id === 'cursor')?.configPath, '/home/x/.cursor/mcp.json');
});

test('Claude Code is delegated to its own CLI at user scope', () => {
  const cc = mcpClients('darwin', '/Users/x', {}).find((c) => c.id === 'claude-code');
  assert.equal(cc?.viaCli?.bin, 'claude');
  const args = cc?.viaCli?.args('yungle', '{"command":"npx"}') ?? [];
  assert.deepEqual(args.slice(0, 4), ['mcp', 'add-json', '-s', 'user']);
  // Not the default `local` scope, which would install into whichever directory
  // the command happened to be run from.
  assert.ok(!args.includes('local'));
});

test('every client declares where servers live', () => {
  // Guards against a future client being added and inheriting a hard-coded key.
  for (const c of mcpClients('darwin', '/Users/x', {})) {
    assert.ok(c.serversKey.length > 0, c.id);
  }
});

// ── Scope safety ────────────────────────────────────────────────────────────

test('write scopes are identified for refusal', () => {
  assert.deepEqual(writeScopes(['transfers:read', 'collections:read']), []);
  assert.deepEqual(writeScopes(['transfers:read', 'transfers:write']), ['transfers:write']);
  assert.deepEqual(
    writeScopes(['transfers:write', 'collections:write', 'contacts:read']).sort(),
    ['collections:write', 'transfers:write'],
  );
});

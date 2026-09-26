import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * `yungle mcp install` — write the Yungle MCP server into an agent client's
 * config, instead of asking someone to hand-edit JSON.
 *
 * The stdio MCP server has been installable for a while, but installing it meant
 * five fiddly steps: find the right config file for your client, learn its
 * schema, add an entry without breaking the ones already there, paste a key, and
 * restart. Every one of those is a place to give up. This collapses it to one
 * command.
 *
 * **The whole risk here is other people's config files.** These files hold every
 * other MCP server a person has set up. Corrupting one does not lose Yungle data,
 * it breaks their whole agent setup — a far worse outcome than the feature is
 * worth. So the rules below are absolute:
 *
 *  - Never write a file whose current contents did not parse. A config with a
 *    trailing comma is a file to refuse, not to "fix" by overwriting.
 *  - Never drop a key we did not add. Merging is a read-modify-write over the
 *    parsed object, never a template.
 *  - Always back up before the first modification.
 *  - Be idempotent: running twice must produce no second change.
 *
 * The decisions are pure functions here so they can be tested without touching a
 * real config; only `install()` in index.ts does I/O.
 */

export type ClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'windsurf';

export interface McpClient {
  id: ClientId;
  label: string;
  /**
   * Where the servers live inside the JSON document. Every client in this table
   * happens to use `mcpServers`, but it is declared rather than assumed — VS
   * Code's MCP support uses `servers`, and the next client added will not be
   * checked against a hard-coded string if this stays explicit.
   */
  serversKey: string;
  /**
   * `null` when this client is not configurable on this platform. Claude Desktop
   * has no Linux build, so there is no path to write to and pretending otherwise
   * would create a file nothing reads.
   */
  configPath: string | null;
  /**
   * Claude Code owns its own config through `claude mcp add-json`, and its user
   * config (`~/.claude.json`) carries far more than MCP servers — conversation
   * state, project history, onboarding flags. Hand-editing it is not supported
   * and is the one file here most likely to be actively rewritten underneath us.
   * So it is delegated to the tool that owns it.
   */
  viaCli?: { bin: string; args: (name: string, json: string) => string[] };
}

/** Per-client config locations. Split out so tests can pin every platform. */
export function mcpClients(
  os: string = platform(),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): McpClient[] {
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  return [
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      serversKey: 'mcpServers',
      configPath:
        os === 'darwin'
          ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : os === 'win32'
            ? join(appData, 'Claude', 'claude_desktop_config.json')
            : // No Linux build of Claude Desktop exists, so there is nothing to write.
              null,
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      serversKey: 'mcpServers',
      configPath: join(home, '.claude.json'),
      viaCli: {
        bin: 'claude',
        // `-s user` so it applies everywhere, not just the directory the install
        // happened to be run from — the default scope is `local`, which would
        // silently give a per-project install nobody asked for.
        args: (name, json) => ['mcp', 'add-json', '-s', 'user', name, json],
      },
    },
    {
      id: 'cursor',
      label: 'Cursor',
      serversKey: 'mcpServers',
      configPath: join(home, '.cursor', 'mcp.json'),
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      serversKey: 'mcpServers',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    },
  ];
}

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The entry itself.
 *
 * `npx -y yungle-mcp` rather than an absolute path to a global install: it needs
 * no prior `npm i -g`, and it picks up new versions without anyone re-running
 * this. The cost is a network fetch on first launch, which is what essentially
 * every published MCP server does.
 *
 * The key goes in `env` because that is the only channel a stdio MCP server has.
 * It means the key is duplicated into a second plaintext file, which the caller
 * warns about — a read-only key limits what that is worth to an attacker, and
 * `mcp install` refuses write scopes for exactly that reason.
 */
export function serverEntry(opts: { apiKey: string; baseUrl?: string }): ServerEntry {
  const env: Record<string, string> = { YUNGLE_API_KEY: opts.apiKey };
  // Only when overridden — writing the default in would freeze it into every
  // config we ever touch, and it is the MCP server's job to know its own default.
  if (opts.baseUrl) env.YUNGLE_API_URL = opts.baseUrl;
  return { command: 'npx', args: ['-y', 'yungle-mcp'], env };
}

export type MergeOutcome =
  | { kind: 'added'; config: Record<string, unknown> }
  | { kind: 'updated'; config: Record<string, unknown>; previous: unknown }
  | { kind: 'unchanged' };

/**
 * Merge our entry into a parsed config, preserving everything else.
 *
 * Returns `unchanged` when the entry is already exactly right, which is what
 * makes re-running safe and keeps the command honest about having done nothing.
 * Deep-equality rather than presence: a key rotation must still be applied, and
 * reporting "already installed" after `yungle auth login` with a new key would
 * leave the client authenticating with a revoked credential.
 */
export function mergeServerEntry(
  existing: unknown,
  serversKey: string,
  name: string,
  entry: ServerEntry,
): MergeOutcome {
  // A JSON document whose root is not an object (null, an array, a string) is
  // not a config we understand. Treat it as a refusal at the call site rather
  // than replacing it with a fresh object and destroying whatever it was.
  const root: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const servers = root[serversKey];
  const nextServers: Record<string, unknown> =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? { ...(servers as Record<string, unknown>) }
      : {};

  const before = nextServers[name];
  if (before !== undefined && deepEqual(before, entry)) return { kind: 'unchanged' };

  nextServers[name] = entry;
  root[serversKey] = nextServers;
  return before === undefined
    ? { kind: 'added', config: root }
    : { kind: 'updated', config: root, previous: before };
}

/**
 * Structural equality over JSON-shaped values.
 *
 * Not `JSON.stringify(a) === JSON.stringify(b)`: that compares key ORDER too, so
 * a config a person had reformatted, or that another tool rewrote with sorted
 * keys, would read as different and get rewritten on every run — turning an
 * idempotent command into one that churns the file forever.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Reject keys that can do more than read.
 *
 * The MCP server has no tool that writes — a test in that package enforces it —
 * so a write scope here buys nothing and adds real risk. A model can be steered
 * by a filename in a collection it was asked to summarise, and MCP has no
 * confirmation primitive, so the only durable guarantee is that the credential
 * itself cannot mutate anything.
 *
 * Checked by *scope name*, not by trying a request: this must work offline and
 * must not depend on the API being reachable at install time.
 */
export function writeScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => s.endsWith(':write'));
}

/** Write scopes the MCP server has no tool for: always refused at install. */
export function unusableWriteScopes(scopes: readonly string[]): string[] {
  return writeScopes(scopes).filter((s) => s !== 'transfers:write');
}

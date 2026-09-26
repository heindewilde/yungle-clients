import { resolveKey } from './config';
import {
  mcpClients,
  mergeServerEntry,
  serverEntry,
  unusableWriteScopes,
  writeScopes,
  type ClientId,
  type McpClient,
} from './mcp-install';
import { stringFlag } from './args';
import type { YungleClient } from 'yungle-client';
import { CliError } from './errors';
import { out } from './output';
import { table } from './ui';

type Flags = Record<string, string | boolean>;

// ── yungle mcp ──────────────────────────────────────────────────────────────

/**
 * Install the Yungle MCP server into whichever agent clients are present.
 *
 * The point is to remove five steps that each lose people: find the config file,
 * learn its schema, edit it without breaking the servers already in it, paste a
 * key, restart. The safety rules for touching those files live in
 * `mcp-install.ts`; this function is the I/O around them.
 */
export async function mcp(
  positionals: string[],
  flags: Flags,
  json: boolean,
  client: (flags: Flags) => YungleClient,
): Promise<number> {
  const sub = positionals[0] ?? 'install';
  if (sub !== 'install' && sub !== 'status') {
    throw new CliError(`Unknown: yungle mcp ${sub}.`, 'yungle mcp install   or   yungle mcp status', 'usage', 2);
  }

  const { readFile, writeFile, mkdir, copyFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const all = mcpClients();
  const only = stringFlag(flags.client);
  if (only && !all.some((c) => c.id === only)) {
    throw new CliError(`Unknown client: ${only}.`, `--client ${all.map((c) => c.id).join(' | ')}`, 'usage', 2);
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
      table(
        rows.map((r) => [r.client, r.installed ? 'installed' : r.path ? 'not installed' : 'not available on this platform']),
        { flex: 1 },
      ),
    );
  }

  // ── install ───────────────────────────────────────────────────────────────
  const resolved = await resolveKey();
  if (!resolved) {
    throw new CliError(
      'The local MCP server needs an API key. Or skip keys: add https://yungle.co/mcp to your assistant and sign in there.',
      'yungle login --key',
      'not_signed_in',
    );
  }

  // A `yungle login` session is an hour-long token that refreshes itself here,
  // not in an assistant's config file: written there, it would stop working
  // within the hour with no sign of why.
  if (resolved.source.includes('(yungle login)')) {
    throw new CliError(
      'The local MCP server needs an API key; a browser sign-in expires within the hour. ' +
        'Easiest: add https://yungle.co/mcp to your assistant and sign in there. Or save a key for this:',
      'yungle login --key',
      'not_signed_in',
    );
  }

  /**
   * Refuse a key with more power than the server can use.
   *
   * The server's only writes are sharing a link and — with a yes from the user
   * in their client, every time — emailing it (`transfers:write`). Any other
   * write scope buys the assistant nothing and puts a stronger credential in a
   * config file it reads, so it is refused. `transfers:write` itself needs
   * `--allow-write`: a read-only key stays the default, because a model can be
   * steered by a filename.
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
    throw new CliError(
      `Could not check what this key may do (${(err as Error).message}), so nothing was installed: an assistant should never get a key of unknown scope.`,
    );
  }
  const writes = writeScopes(scopes);
  const unusable = unusableWriteScopes(scopes);
  if (unusable.length > 0 || (writes.length > 0 && flags['allow-write'] !== true)) {
    throw new CliError(
      (unusable.length > 0
        ? `This key can ${unusable.join(', ')}, which the MCP server never uses.`
        : `This key can write (${writes.join(', ')}).`) +
        ' Give an assistant as little as it needs: the :read scopes to answer questions, plus transfers:write' +
        ' (with --allow-write) to share links. Or skip keys: add https://yungle.co/mcp to your assistant and sign in.',
      'yungle open keys',
      'insufficient_scope',
    );
  }

  const entry = serverEntry({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
  const dryRun = flags['dry-run'] === true;
  const results: Array<{ client: ClientId; action: string; path?: string; detail?: string }> = [];

  for (const c of targets) {
    const r = await installInto(c, entry, { dryRun, readFile, writeFile, mkdir, copyFile, dirname });
    results.push({ client: c.id, ...r });
  }

  const changed = results.filter((r) => r.action === 'added' || r.action === 'updated');
  const lines = [table(results.map((r) => [r.client, `${r.action}${r.detail ? ` — ${r.detail}` : ''}`]), { flex: 1 })];

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

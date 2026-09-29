/**
 * An upload target packed into one shell-safe argument, for `yungle put`.
 *
 * The MCP server's `create_transfer` hands an agent one command per file:
 * `npx -y yungle-cli put <path> --target <blob>`. The blob carries the tus
 * endpoint, the file id, its size and its upload token — a capability to write
 * exactly that one file, for two hours, which is why `put` needs no API key and
 * why the agent's shell needs no Yungle credentials at all.
 */

export interface PackedTarget {
  /** tus endpoint */
  e: string;
  /** file id */
  i: string;
  /** upload token */
  t: string;
  /** name */
  n: string;
  /** size in bytes */
  s: number;
}

export function packTarget(t: PackedTarget): string {
  return Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
}

export function unpackTarget(blob: string): PackedTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(blob.trim(), 'base64url').toString('utf8'));
  } catch {
    throw new Error('That --target is not one Yungle issued (it does not decode).');
  }
  const p = parsed as Partial<PackedTarget>;
  if (
    typeof p?.e !== 'string' ||
    typeof p.i !== 'string' ||
    typeof p.t !== 'string' ||
    typeof p.n !== 'string' ||
    typeof p.s !== 'number' ||
    !/^https?:\/\//.test(p.e)
  ) {
    throw new Error('That --target is incomplete; ask for a fresh upload command.');
  }
  return p as PackedTarget;
}

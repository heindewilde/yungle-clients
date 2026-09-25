// The MCP registry reads server.json, npm reads package.json; changesets only
// bumps the second. Keep them equal, or the registry advertises a version npm
// does not have.
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../packages/mcp-server/', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
const file = new URL('server.json', dir);
const server = JSON.parse(readFileSync(file, 'utf8'));
server.version = version;
for (const p of server.packages) if (p.identifier === 'yungle-mcp') p.version = version;
writeFileSync(file, `${JSON.stringify(server, null, 2)}\n`);
console.log(`✓ server.json → ${version}`);

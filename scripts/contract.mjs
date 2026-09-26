// The SDK against the live API: every operation in the published OpenAPI spec
// must have a call in packages/api-client. Static on purpose — it reads the
// client source, so it needs no key.
//
// The two directions are not equal. A live operation the client lacks is a
// failure: users cannot reach it. A client call the live API lacks is only a
// warning, because the clients ship ahead of the server — a call for an
// endpoint that is built but not yet deployed is the normal state between the
// two releases. `--strict` (or CONTRACT_STRICT=1) fails on those as well, for
// checking against a server that should already have everything.
import { readFileSync } from 'node:fs';

const SPEC = process.env.YUNGLE_OPENAPI_URL ?? 'https://yungle.co/api/v1/openapi.json';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const res = await fetch(SPEC, { headers: { 'User-Agent': 'yungle-clients-contract' } });
if (!res.ok) {
  console.error(`✗ ${SPEC}: HTTP ${res.status}`);
  process.exit(1);
}
const spec = await res.json();

const shape = (path) => path.replace(/\{[^}]+\}/g, '{}');
const inSpec = new Set();
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  if (path === '/openapi.json') continue;
  for (const m of METHODS) if (item[m]) inSpec.add(`${m.toUpperCase()} ${shape(path)}`);
}

const src = readFileSync(new URL('../packages/api-client/src/index.ts', import.meta.url), 'utf8');
const inClient = new Set();
for (const m of src.matchAll(/this\.request\(\s*'([A-Z]+)',\s*[`']([^`'?$]*(?:\$\{[^}]+\}[^`'?$]*)*)/g)) {
  // A `${…}` right after a path segment rather than a slash is a query string.
  const path = m[2].replace(/([^/])\$\{[^}]+\}$/, '$1').replace(/\$\{[^}]+\}/g, '{x}');
  inClient.add(`${m[1]} ${shape(path)}`);
}

const missing = [...inSpec].filter((op) => !inClient.has(op)).sort();
const ahead = [...inClient].filter((op) => !inSpec.has(op)).sort();
const strict = process.argv.includes('--strict') || process.env.CONTRACT_STRICT === '1';
for (const op of missing) console.error(`✗ in the API, not in the client: ${op}`);
for (const op of ahead) console.error(`${strict ? '✗' : '!'} in the client, not yet in the API: ${op}`);
if (missing.length || (strict && ahead.length)) process.exit(1);
console.log(
  `✓ all ${inSpec.size} live operations are in the client` +
    (ahead.length ? `; ${ahead.length} more await a server release` : '') +
    ` (${SPEC})`,
);

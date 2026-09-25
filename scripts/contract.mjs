// The SDK against the live API: every operation in the published OpenAPI spec
// must have a call in packages/api-client, and every call must exist in the
// spec. Static on purpose — it reads the client source, so it needs no key.
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
const stale = [...inClient].filter((op) => !inSpec.has(op)).sort();
for (const op of missing) console.error(`✗ in the API, not in the client: ${op}`);
for (const op of stale) console.error(`✗ in the client, not in the API: ${op}`);
if (missing.length || stale.length) process.exit(1);
console.log(`✓ ${inSpec.size} operations, client and API agree (${SPEC})`);

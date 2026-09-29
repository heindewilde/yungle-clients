// The SDK's TYPES against the live API: every interface in
// packages/api-client/src/types.ts that mirrors a resource is compared, field
// by field, with the schema the published OpenAPI document gives it.
//
// `contract.mjs` proves every operation has a call; this proves the call's
// return type tells the truth. Read through the TypeScript checker rather than
// by pattern, so `extends Omit<…>` and friends resolve as the compiler sees them.
//
// Failures — the client would mislead someone:
//   - a field the client reads that the API never sends
//   - the client says non-null where the API may send null
//   - the client says a field is always there where the API may omit it
//   - a different kind of value (string vs number, array vs object)
// Warnings — the client is merely incomplete or cautious:
//   - a field the API sends that the client does not declare (additive)
//   - the client says nullable or optional where the API never is
// `--strict` (or CONTRACT_STRICT=1) fails on warnings too.
//
// The spec comes from YUNGLE_OPENAPI_URL (default production) or, for checking
// against an unreleased server, YUNGLE_OPENAPI_FILE.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Client interface → the spec's `components/schemas` name. */
const MAP = {
  Me: 'Me',
  UploadTarget: 'UploadTarget',
  Transfer: 'Transfer',
  TransferSummary: 'TransferSummary',
  TransferFile: 'TransferFile',
  RecipientStatus: 'Recipient',
  DownloadEvent: 'Download',
  Collection: 'Collection',
  CollectionSummary: 'CollectionSummary',
  CollectionFile: 'CollectionFile',
  Folder: 'Folder',
  Guest: 'Guest',
  Contact: 'Contact',
  WebhookEndpoint: 'Webhook',
  WebhookDelivery: 'WebhookDelivery',
  // What `/events` returns. The bare `WebhookEvent` is the push payload, which
  // has no `deliveryId` and no schema of its own.
  PulledWebhookEvent: 'WebhookEvent',
  DownloadLink: 'DownloadLink',
  DownloadLinks: 'DownloadLinks',
  ImportStarted: 'ImportStarted',
  ImportStatus: 'Import',
  UploadRequest: 'UploadRequest',
  Submission: 'Submission',
};

/**
 * Deliberately looser than the API, with the reason. A warning that can never
 * go away teaches people to stop reading warnings, so these are named instead.
 */
const CAUTIOUS = {
  'Me.key.via': 'absent on servers before 2026-09-26; callers compare with `===`, never assume presence',
  'Me.key.canEmail': 'absent on servers before 2026-09-26; the CLI tests `=== false`, so absent means "may email"',
  'UploadTarget.uploadTokenExpiresAt': 'absent on servers before 2026-09-29; the keeper reads the expiry from the token itself',
};

const strict = process.argv.includes('--strict') || process.env.CONTRACT_STRICT === '1';
const source = process.env.YUNGLE_OPENAPI_FILE ?? process.env.YUNGLE_OPENAPI_URL ?? 'https://yungle.co/api/v1/openapi.json';

async function loadSpec() {
  if (process.env.YUNGLE_OPENAPI_FILE) return JSON.parse(readFileSync(source, 'utf8'));
  const res = await fetch(source, { headers: { 'User-Agent': 'yungle-clients-contract' } });
  if (!res.ok) {
    console.error(`✗ ${source}: HTTP ${res.status}`);
    process.exit(1);
  }
  return res.json();
}

const spec = await loadSpec();
const schemas = spec.components?.schemas ?? {};
if (!schemas.Transfer) {
  // A server from before typed responses: nothing to compare against yet.
  console.log(`! ${source} publishes no response schemas; type contract skipped`);
  process.exit(0);
}

// ── The spec side ───────────────────────────────────────────────────────────

function deref(s) {
  let out = s ?? {};
  for (let i = 0; out.$ref && i < 10; i++) out = schemas[out.$ref.split('/').pop()] ?? {};
  return out;
}

/** { nullable, kind, schema } with `null` peeled off whichever spelling carries it. */
function specShape(raw) {
  const s = deref(raw);
  const union = s.anyOf ?? s.oneOf;
  if (union) {
    const nonNull = union.filter((u) => deref(u).type !== 'null');
    const inner = nonNull.length === 1 ? specShape(nonNull[0]) : { nullable: false, kind: 'any', schema: s };
    return { ...inner, nullable: inner.nullable || nonNull.length < union.length };
  }
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const nullable = types.includes('null');
  const t = types.find((x) => x !== 'null');
  const kind = t === 'integer' ? 'number' : (t ?? (s.properties ? 'object' : 'any'));
  return { nullable, kind, schema: s };
}

// ── The client side ─────────────────────────────────────────────────────────

const typesFile = fileURLToPath(new URL('../packages/api-client/src/types.ts', import.meta.url));
const program = ts.createProgram([typesFile], { strict: true, target: ts.ScriptTarget.ES2022, noEmit: true });
const checker = program.getTypeChecker();
const file = program.getSourceFile(typesFile);
const exported = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(file)).map((s) => [s.name, s]));

function clientShape(type) {
  const parts = type.isUnion() ? type.types : [type];
  const nullable = parts.some((p) => p.flags & ts.TypeFlags.Null);
  const rest = parts.filter((p) => !(p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
  const kinds = new Set(
    rest.map((p) => {
      if (p.flags & ts.TypeFlags.StringLike) return 'string';
      if (p.flags & ts.TypeFlags.NumberLike) return 'number';
      if (p.flags & ts.TypeFlags.BooleanLike) return 'boolean';
      if (p.flags & ts.TypeFlags.TypeParameter || p.flags & ts.TypeFlags.Unknown || p.flags & ts.TypeFlags.Any) return 'any';
      if (checker.isArrayType(p)) return 'array';
      return 'object';
    }),
  );
  const kind = kinds.size === 1 ? [...kinds][0] : 'any';
  return { nullable, kind, type: rest[0] };
}

// ── The comparison ──────────────────────────────────────────────────────────

const failures = [];
const warnings = [];

function compareObject(clientType, specSchema, path) {
  const s = deref(specSchema);
  if (!s.properties) return; // a record (`data`): shaped per event, nothing to hold fields to
  const required = new Set(s.required ?? []);
  const clientProps = new Map(checker.getPropertiesOfType(clientType).map((p) => [p.name, p]));

  for (const name of Object.keys(s.properties)) {
    if (!clientProps.has(name)) warnings.push(`${path}.${name}: sent by the API, not declared by the client`);
  }
  for (const [name, prop] of clientProps) {
    const where = `${path}.${name}`;
    if (!(name in s.properties)) {
      failures.push(`${where}: declared by the client, never sent by the API`);
      continue;
    }
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    if (!optional && !required.has(name)) failures.push(`${where}: the client says always present; the API may omit it`);
    if (optional && required.has(name) && !(where in CAUTIOUS)) {
      warnings.push(`${where}: the client says optional; the API always sends it`);
    }
    compareValue(checker.getTypeOfSymbol(prop), s.properties[name], where);
  }
}

function compareValue(type, specSchema, where) {
  const c = clientShape(type);
  const s = specShape(specSchema);
  if (!c.nullable && s.nullable) failures.push(`${where}: the client says non-null; the API may send null`);
  if (c.nullable && !s.nullable) warnings.push(`${where}: the client says nullable; the API never sends null`);
  if (c.kind === 'any' || s.kind === 'any') return;
  if (c.kind !== s.kind) {
    failures.push(`${where}: the client says ${c.kind}; the API sends ${s.kind}`);
    return;
  }
  if (c.kind === 'array') compareValue(checker.getTypeArguments(c.type)[0], s.schema.items, `${where}[]`);
  if (c.kind === 'object') compareObject(c.type, s.schema, where);
}

for (const [clientName, specName] of Object.entries(MAP)) {
  const symbol = exported.get(clientName);
  if (!symbol) {
    failures.push(`${clientName}: not exported from types.ts`);
    continue;
  }
  if (!schemas[specName]) {
    failures.push(`${clientName}: the API publishes no ${specName} schema`);
    continue;
  }
  compareObject(checker.getDeclaredTypeOfSymbol(symbol), schemas[specName], clientName);
}

for (const f of failures) console.error(`✗ ${f}`);
for (const w of warnings) console.error(`${strict ? '✗' : '!'} ${w}`);
if (failures.length || (strict && warnings.length)) process.exit(1);
console.log(
  `✓ ${Object.keys(MAP).length} client types agree with the API's schemas` +
    (warnings.length ? `; ${warnings.length} warning(s)` : '') +
    ` (${source})`,
);

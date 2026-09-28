import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Bundle for publication, exactly as `yungle-client` does (see its build.mjs
 * for why `prepare` must stay and why declarations get explicit extensions).
 *
 * Browser-first: this code runs in the website, the vault and the browser
 * extension, and only needs WebCrypto — which Node 22 also has as a global.
 * No dependencies, so the bundle is the whole library.
 */
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  format: 'esm',
  mainFields: ['module', 'main'],
});
console.log('✓ dist/index.mjs');

// Declarations. Run from here rather than chained in package.json so the fixup
// and the check below cannot be skipped by invoking one script and not another.
const tsc = spawnSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit', shell: true });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
console.log('✓ dist/*.d.ts');

/**
 * Add explicit extensions to relative imports IN THE EMITTED DECLARATIONS.
 *
 * The repo convention is extensionless relative imports, because Turbopack
 * resolves the transpiled workspace packages that way — that convention is
 * correct and the source is left alone. But this is a published, `"type":
 * "module"` package, and `tsc` copies specifiers through verbatim: the emitted
 * `index.d.ts` said `export * from './types'`, which every consumer using
 * `moduleResolution: nodenext` — the modern default — rejects with
 *
 *   TS2834: Relative import paths need explicit file extensions …
 *
 * So the package type-checked perfectly in this repo and errored in a consumer's
 * build. `'./types.js'` is the correct specifier even though the file on disk is
 * `types.d.ts`; that is how nodenext resolves declarations.
 *
 * Found by installing the published tarball into a clean directory and running
 * tsc against it — never visible from inside the workspace, where the symlink
 * means the source is used and these files are never resolved at all.
 */
let fixed = 0;
for (const f of readdirSync('dist').filter((f) => f.endsWith('.d.ts'))) {
  const p = `dist/${f}`;
  const before = readFileSync(p, 'utf8');
  const after = before.replace(
    /(\bfrom\s+['"])(\.\.?\/[^'"]*?)(['"])/g,
    (m, pre, spec, post) => (/\.[a-z]+$/i.test(spec) ? m : `${pre}${spec}.js${post}`),
  );
  if (after !== before) {
    writeFileSync(p, after);
    fixed++;
  }
}
console.log(`✓ extensions added to ${fixed} declaration file(s)`);

// The guard. This defect is invisible from inside the workspace, so assert it
// rather than trusting the rewrite above to have matched every shape.
const offenders = [];
for (const f of readdirSync('dist').filter((f) => f.endsWith('.d.ts'))) {
  for (const line of readFileSync(`dist/${f}`, 'utf8').split('\n')) {
    const m = line.match(/\bfrom\s+['"](\.\.?\/[^'"]+)['"]/);
    if (m && !/\.[a-z]+$/i.test(m[1])) offenders.push(`${f}: ${m[1]}`);
  }
}
if (offenders.length > 0) {
  console.error('✗ extensionless relative import(s) in declarations — TS2834 for consumers:');
  for (const o of offenders) console.error(`    ${o}`);
  process.exit(1);
}
console.log('✓ declarations resolve under moduleResolution: nodenext');

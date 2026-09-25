import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Bundle for publication: runtime, then declarations, then a check that the
 * declarations are actually consumable.
 *
 * Unlike every other workspace package, this one's `exports` resolves to
 * `dist/`, not `src/` — a published package cannot ship TypeScript, because
 * `npm i yungle-client` installs for people with no TS toolchain in the loop.
 *
 * **That is why `prepare` must stay in package.json.** It looks redundant next
 * to `prepublishOnly` and is not: `prepublishOnly` runs on publish, while
 * `prepare` runs on every install, and `apps/cli` resolves this package's types
 * through `dist/index.d.ts`. Remove it and a fresh clone typechecks against a
 * `dist/` that was never built — "Cannot find module 'yungle-client'", pointing
 * at the CLI rather than at the cause. Locally it hides, because `dist/` is
 * already on disk from an earlier build; CI is where it shows up.
 *
 * Dependency-free by design, so nothing is external — the whole client is one
 * file. Types come from `tsc -p tsconfig.build.json`, because esbuild does not
 * emit declarations and a "typed client" whose `.d.ts` is missing is just a
 * fetch wrapper.
 */
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'neutral',
  target: 'node22',
  format: 'esm',
  // `platform: 'neutral'` keeps it usable outside Node too — Bun, Deno, and
  // edge runtimes all have fetch, which is the only thing this needs.
  mainFields: ['module', 'main'],
  define: {
    __YUNGLE_CLIENT_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version),
  },
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

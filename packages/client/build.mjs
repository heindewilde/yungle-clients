import { build } from 'esbuild';

/**
 * Bundle for publication.
 *
 * This package ships its TypeScript source to in-repo consumers (the workspace
 * `exports` resolves through tsx), but a published package cannot: `npm i
 * yungle-client` installs for people with no TypeScript toolchain in the loop.
 *
 * Dependency-free by design, so nothing is external — the whole client is one
 * file. Types come from `tsc -p tsconfig.build.json` alongside this, because
 * esbuild does not emit declarations and a "typed client" whose `.d.ts` is
 * missing is just a fetch wrapper.
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
});
console.log('✓ dist/index.mjs');

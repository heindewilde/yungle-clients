import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

/**
 * Bundle the CLI into one publishable file.
 *
 * Every other package in this monorepo ships its TypeScript source and is
 * consumed through `tsx` — which is right for things that only ever run inside
 * the repo, and wrong for the one artifact that leaves it. `npm i -g` installs
 * for people who have no tsx and no interest in acquiring one, so the binary
 * has to be plain JavaScript that `node` can execute directly.
 *
 * Workspace dependencies (`yungle-client`) are bundled in; they are not
 * published separately and a bare `workspace:*` in a published package.json
 * would be uninstallable. `tus-js-client` stays external because it is a real
 * npm dependency with its own platform-specific behaviour, and inlining it
 * would mean shipping a fork of it.
 */
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/yungle.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['tus-js-client'],
  banner: {
    // The shebang and the entry call, prepended rather than kept in a separate
    // file, so there is exactly one artifact to publish and to chmod.
    js: '#!/usr/bin/env node',
  },
  footer: {
    js: 'await loadCredentials();\nprocess.exit(await main(process.argv.slice(2)));',
  },
});

await chmod('dist/yungle.mjs', 0o755);
console.log('✓ dist/yungle.mjs');

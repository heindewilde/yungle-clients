import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));

/**
 * Same reasoning as the CLI's build: this is published to npm and run with
 * `npx`, so it has to be plain JavaScript that `node` executes directly.
 * `yungle-client` is bundled in (it is a workspace package and a
 * `workspace:*` range in a published manifest is uninstallable); the MCP SDK
 * and zod stay external as ordinary npm dependencies.
 */
await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  define: { __YUNGLE_MCP_VERSION__: JSON.stringify(version) },
  external: ['@modelcontextprotocol/sdk', 'zod'],
  banner: { js: '#!/usr/bin/env node' },
  footer: { js: 'await startStdioServer();' },
});

await chmod('dist/server.mjs', 0o755);
console.log('✓ dist/server.mjs');

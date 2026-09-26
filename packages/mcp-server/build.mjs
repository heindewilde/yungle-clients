import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
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

// The library entry: createServer without starting anything, for hosting the
// same tools over HTTP (yungle.co/mcp does exactly this).
await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  define: { __YUNGLE_MCP_VERSION__: JSON.stringify(version) },
  external: ['@modelcontextprotocol/sdk', 'zod', 'yungle-client'],
});
console.log('✓ dist/index.mjs');

const tsc = spawnSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit', shell: true });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
console.log('✓ dist/*.d.ts');

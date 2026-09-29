import { defineConfig } from '@playwright/test';

/**
 * The extension in a real Chromium, against a LOCAL Yungle (the server
 * worktree on :3002, upload-svc on :4002 — see README.md).
 * Build first with `pnpm e2e:build`.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
});

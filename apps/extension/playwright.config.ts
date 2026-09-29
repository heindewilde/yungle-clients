import { defineConfig } from '@playwright/test';

/**
 * The extension in a real Chromium, against a LOCAL Yungle (the server
 * worktree's `dev:serve` on :3002 and upload-svc on :4002 — see e2e/README).
 * Build first with `pnpm e2e:build`.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
});

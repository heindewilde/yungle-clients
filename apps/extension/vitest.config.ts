import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: { include: ['lib/**/*.test.ts', 'content/**/*.test.ts'] },
});

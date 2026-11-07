import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths: the built page works from any sub-path.
  base: './',
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000 },
});

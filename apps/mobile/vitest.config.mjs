import { defineConfig } from 'vitest/config';

// Unit tests of the host's pure modules (origin config, navigation policy, load state).
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});

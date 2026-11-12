import { defineConfig } from 'vitest/config';

// Unit tests only; e2e/ is Playwright (pnpm e2e).
export default defineConfig({
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});

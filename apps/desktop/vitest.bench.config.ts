import { defineConfig } from 'vitest/config';

// Perf benches (docs/14): not part of `pnpm test`. `pnpm --filter @calaba/desktop bench:feed`.
export default defineConfig({
  test: { include: ['src/**/__bench__/*.bench.ts'], testTimeout: 300_000 },
});

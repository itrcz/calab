import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Same `@/` alias as tsconfig, so tests can import modules that use it (lib/legal).
export default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } } });

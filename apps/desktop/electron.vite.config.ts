import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { bundledPackages } from './scripts/bundledPackages';

const require = createRequire(import.meta.url);

// @timephy/rnnoise-wasm only exports its ready-made worklet, which discards the
// RNNoise VAD probability. We need VAD for voice activation (docs/02-media.md),
// so our own worklet imports the package internals (sync WASM glue + atob
// polyfill) through this alias, bypassing the package "exports" map.
const rnnoiseDist = dirname(require.resolve('@timephy/rnnoise-wasm'));

// Third-party notices: packages that end up in any bundle (scripts/third-party-notices.mjs).
const BUNDLED = resolve(__dirname, 'build/.gen/bundled-desktop.json');

/**
 * The renderer owns live media objects (Room, AudioContext, tracks) in module
 * singletons. Partial HMR would duplicate them (UI bound to one instance, media
 * to another), so every change in dev triggers a full reload instead.
 */
function fullReloadOnly(): Plugin {
  return {
    name: 'calaba:full-reload-only',
    apply: 'serve',
    handleHotUpdate({ server }) {
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

export default defineConfig({
  main: {
    plugins: [bundledPackages(BUNDLED)],
    build: {
      rollupOptions: {
        // mailEngine: the mail engine utilityProcess (ADR-0088 §2), forked by src/main/mail/index.ts.
        input: { index: resolve(__dirname, 'src/main/index.ts'), mailEngine: resolve(__dirname, 'src/main/mail/engine.ts') },
      },
    },
  },
  preload: {
    plugins: [bundledPackages(BUNDLED)],
    build: {
      rollupOptions: {
        // overlay: the annotation overlay window's receive-only preload (ADR-0028).
        input: { index: resolve(__dirname, 'src/preload/index.ts'), overlay: resolve(__dirname, 'src/preload/overlay.ts') },
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: [
        { find: '@rnnoise-dist', replacement: rnnoiseDist },
        // CALABA_REACT_PROFILING=1: the profiling build of react-dom, so fibers carry
        // actualDuration / selfBaseDuration for tools/perf-call.ts (docs/14 «Ререндеры в звонке»).
        ...(process.env['CALABA_REACT_PROFILING'] === '1' ? [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] : []),
      ],
    },
    build: {
      // electron-vite leaves the renderer unminified: minifying the ~4.3 MB main chunk halves it
      // and cuts V8 compile time on every start (docs/18 step 1). CALABA_RENDERER_MINIFY=0 keeps
      // component names readable for tools/perf-probe.ts render counts.
      minify: process.env['CALABA_RENDERER_MINIFY'] === '0' ? false : 'esbuild',
      // 'hidden': .map files next to the bundle without a sourceMappingURL comment, so DevTools
      // never fetches them and they are not shipped (electron-builder.yml excludes **/*.map);
      // a stack from a production log is decoded against the maps of the same commit's build.
      sourcemap: 'hidden',
      // overlay.html: the presenter's annotation overlay window (ADR-0028).
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), overlay: resolve(__dirname, 'src/renderer/overlay.html') } },
    },
    // Pre-bundle the worklet's deps at startup: otherwise Vite discovers them on
    // the first mic start and force-reloads the page in the middle of connect().
    optimizeDeps: {
      include: ['@rnnoise-dist/polyfills.js', '@rnnoise-dist/generated/rnnoise-sync.js', 'livekit-client'],
    },
    // CALABA_MAIL_MOCK=1 pnpm dev:desktop: the mail section on the in-memory mock (ADR-0088 §7).
    ...(process.env['CALABA_MAIL_MOCK'] === '1' ? { define: { 'import.meta.env.VITE_MAIL_MOCK': JSON.stringify('1') } } : {}),
    worker: { format: 'es', plugins: () => [bundledPackages(BUNDLED)] },
    plugins: [react(), tailwindcss(), fullReloadOnly(), bundledPackages(BUNDLED)],
  },
});

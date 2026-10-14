import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { bundledPackages } from './scripts/bundledPackages';

/**
 * Web client build (ADR-0015): the same renderer, VITE_PLATFORM=web (.env.web), no
 * Electron main/preload. `vite build --config vite.web.config.ts --mode web` → dist-web/.
 * `vite preview` serves dist-web and proxies /api + /gateway to a local API
 * (CALABA_WEB_PROXY, default http://127.0.0.1:3000) — same origin, like Caddy on the stand.
 */
const require = createRequire(import.meta.url);
const rnnoiseDist = dirname(require.resolve('@timephy/rnnoise-wasm'));
// The release stamps the bundle with VERSION (infra/docker/release.sh builds the web client without
// `npm version`, unlike release.yml for the desktop): package.json (0.1.0) is the dev fallback only —
// a bundle stamped older than the server keeps showing «Обновить страницу» after every reload.
const version = process.env.VERSION || process.env.CALABA_VERSION || (require('./package.json') as { version: string }).version;

/** The CSP of the web build comes from the server (Caddy); the Electron meta CSP is dropped. */
function stripMetaCsp(): Plugin {
  return {
    name: 'calaba:strip-meta-csp',
    transformIndexHtml: (html) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/, ''),
  };
}

/**
 * Web app icons (owner artwork, build/icons/web — see scripts/gen-icons.sh): the files are the
 * `publicDir`, this adds the <link>s and the PWA manifest. Only for the web build: the Electron
 * window/Dock/tray icons come from electron-builder and main.
 * Phone / PWA (ADR-0021): the viewport meta (edge to edge under the iOS notch — the app pads with
 * env(safe-area-inset-*); Android resizes the layout for the keyboard), the iOS home-screen metas
 * and an install-only service worker (sw.js: no fetch handler, no cache — always the deployed app).
 */
/**
 * PWA service worker: install-only. No fetch handler and no cache, so every request goes to the
 * network and the app is always the deployed version (Caddy serves non-hashed files no-cache).
 * A new sw.js replaces the old one at once.
 */
const SERVICE_WORKER = `// Calab — install-only service worker (ADR-0021): no fetch handler, no cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
`;
const WEB_THEME = '#1c1c1e'; // --color-bg (dark), the app opens dark by default
function webIcons(): Plugin {
  const manifest = {
    id: '/',
    name: 'Calab',
    short_name: 'Calab',
    description: 'Голосовой мессенджер для команды',
    lang: 'ru',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: WEB_THEME,
    theme_color: WEB_THEME,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return {
    name: 'calaba:web-icons',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content' },
        injectTo: 'head',
      },
      { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Calab' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'icon', href: '/favicon-32.png', sizes: '32x32', type: 'image/png' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' }, injectTo: 'head' },
      { tag: 'meta', attrs: { name: 'theme-color', content: WEB_THEME }, injectTo: 'head' },
    ],
    // dev/preview serve it from memory, build emits it next to index.html
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(JSON.stringify(manifest));
      });
      server.middlewares.use('/sw.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(SERVICE_WORKER);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest, null, 2) });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: SERVICE_WORKER });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const target = env['CALABA_WEB_PROXY'] ?? process.env['CALABA_WEB_PROXY'] ?? 'http://127.0.0.1:3000';
  const proxy = {
    // ws: the wiki sync socket lives under /api (GET /api/wiki/pages/{id}/sync).
    '/api': { target, ws: true, changeOrigin: false },
    '/gateway': { target, ws: true, changeOrigin: false },
  };
  return {
    root: resolve(__dirname, 'src/renderer'),
    base: '/',
    envDir: __dirname,
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
    resolve: { alias: { '@rnnoise-dist': rnnoiseDist } },
    worker: { format: 'es', plugins: () => [bundledPackages(resolve(__dirname, 'build/.gen/bundled-web.json'))] },
    plugins: [react(), tailwindcss(), stripMetaCsp(), webIcons(), bundledPackages(resolve(__dirname, 'build/.gen/bundled-web.json'))],
    publicDir: resolve(__dirname, 'build/icons/web'),
    build: {
      outDir: resolve(__dirname, 'dist-web'),
      emptyOutDir: true,
      target: 'es2022',
      // No source maps in the deployed bundle (review): nothing consumes them (no error
      // reporting service yet) and they would publish the full client source. For debugging a
      // build: CALABA_WEB_SOURCEMAP=1 → 'hidden' maps (files only, no sourceMappingURL comment).
      sourcemap: (env['CALABA_WEB_SOURCEMAP'] ?? process.env['CALABA_WEB_SOURCEMAP']) === '1' ? 'hidden' : false,
      rollupOptions: {
        output: {
          // Vendor chunks change less often than the app: better caching across deploys, and no
          // single 1.6 MB chunk.
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/]node_modules[\\/](livekit-client|@livekit)[\\/]/.test(id)) return 'livekit';
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
            if (/[\\/]node_modules[\\/]@bufbuild[\\/]/.test(id)) return 'protobuf';
            return undefined;
          },
        },
      },
    },
    server: { port: 5174, strictPort: true, proxy },
    // CALABA_WEB_CSP: emulate the stand's Content-Security-Policy header in `preview` (TESTING.md).
    preview: { port: 4173, strictPort: true, proxy, ...(env['CALABA_WEB_CSP'] ? { headers: { 'Content-Security-Policy': env['CALABA_WEB_CSP'] } } : {}) },
  };
});

/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Build-time default API URL for packaged builds (e.g. the staging stand). */
  readonly MAIN_VITE_DEFAULT_SERVER_URL?: string;
  /**
   * The pinned update feed (https only; .env.production: https://releases.calab.io/). The only feed
   * updates are auto-installed from; empty (dev) → notify-only from the server (shared/updateFeed.ts).
   */
  readonly MAIN_VITE_UPDATE_FEED?: string;
  /**
   * The pinned GitHub update source `owner/repo` (.env.production: itrcz/calab; public, releases
   * only) — the default «Источник обновлений» (shared/updateFeed.ts). Empty → only the S3 feed.
   */
  readonly MAIN_VITE_UPDATE_GITHUB?: string;
  /** '1' only for signed + notarized macOS builds: macOS auto-install too (updateFlow.ts). */
  readonly MAIN_VITE_UPDATES_SIGNED?: string;
  /** Extra CSP connect-src sources (e.g. LiveKit on another domain), space-separated (review L3). */
  readonly MAIN_VITE_CSP_CONNECT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

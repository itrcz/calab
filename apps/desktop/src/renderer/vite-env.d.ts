/// <reference types="vite/client" />

/** Prism grammars (lib/markdown/syntax.ts): side-effect scripts that extend the global `Prism`. */
declare module 'prismjs/components/*';

interface ImportMetaEnv {
  /** 'web' for the browser build (ADR-0015); unset = Electron renderer. */
  readonly VITE_PLATFORM?: 'web';
  readonly VITE_APP_VERSION?: string;
  /** Plans on the landing page («Тариф» → «Подробнее о тарифах», ADR-0024); unset = no link. */
  readonly VITE_PRICING_URL?: string;
  /** '1': the billing cabinet and admin talk to an in-memory mock (lib/billing/mock.ts; dev / QA builds only). */
  readonly VITE_BILLING_MOCK?: string;
}

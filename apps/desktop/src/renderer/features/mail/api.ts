import type { MailApi } from '../../../shared/mail';
import { platform } from '../../platform';
import { createMockMailApi } from './mock/mockApi';

/**
 * The mock is on in a build with VITE_MAIL_MOCK=1 (`CALABA_MAIL_MOCK=1 pnpm dev:desktop`, QA builds) or,
 * in dev builds only, with localStorage `calaba-mail-mock` = '1'. In a production build both are
 * constant-false, so the mock and its fixtures are dropped from the bundle.
 */
const MOCK_BUILD = import.meta.env.VITE_MAIL_MOCK === '1';
const MOCK_DEV = import.meta.env.DEV;

function mockEnabled(): boolean {
  if (MOCK_BUILD) return true;
  if (!MOCK_DEV) return false;
  try {
    return localStorage.getItem('calaba-mail-mock') === '1';
  } catch {
    return false;
  }
}

let api: MailApi | undefined | null = null;

/**
 * The mail API for the UI (ADR-0088 §7): the mock when enabled, else `platform.mail` (Electron), else
 * undefined (web / phone: no mail section). Resolved once per page load.
 */
export function getMailApi(): MailApi | undefined {
  if (api === null) api = mockEnabled() ? createMockMailApi() : platform.mail;
  return api;
}

/**
 * The «Почта» section exists (ADR-0088 §1, §8): a mail API (Electron, or the dev mock) outside the
 * web build — the web client and the phone never show it.
 */
export function mailAvailable(): boolean {
  return platform.kind !== 'web' && getMailApi() !== undefined;
}

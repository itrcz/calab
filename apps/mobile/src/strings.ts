import type { HostError } from './hostState';

/**
 * The host's only own text: the load error surface. Everything else is the web client's UI and
 * its translations. Russian on a Russian device, English otherwise.
 */
type Strings = Record<HostError, readonly [title: string, body: string]> & { retry: string; misconfigured: string };

const ru: Strings = {
  network: ['Нет соединения с Calab', 'Проверьте интернет и попробуйте ещё раз.'],
  server: ['Calab временно недоступен', 'Сервер не ответил. Попробуйте ещё раз через минуту.'],
  blocked: ['Эта страница открывается не в Calab', 'Приложение показывает только Calab.'],
  crashed: ['Страница перестала отвечать', 'Загрузите Calab заново.'],
  retry: 'Повторить',
  misconfigured: 'Сборка без адреса сервера Calab (EXPO_PUBLIC_CALAB_URL).',
};

const en: Strings = {
  network: ['No connection to Calab', 'Check your internet connection and try again.'],
  server: ['Calab is temporarily unavailable', 'The server did not respond. Try again in a minute.'],
  blocked: ['This page does not open in Calab', 'The app shows Calab only.'],
  crashed: ['The page stopped responding', 'Load Calab again.'],
  retry: 'Try again',
  misconfigured: 'This build has no Calab server address (EXPO_PUBLIC_CALAB_URL).',
};

function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en';
  }
}

export const strings = /^ru\b/i.test(deviceLocale()) ? ru : en;

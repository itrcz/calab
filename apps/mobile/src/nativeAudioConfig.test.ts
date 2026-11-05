import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const FLAGS = ['CALAB_IOS_INCOMING_CALLS', 'CALAB_IOS_PUSH_ENVIRONMENT', 'CALAB_IOS_NATIVE_CALL_AUDIO', 'CALAB_IOS_NATIVE_ROOM_AUDIO', 'CALAB_IOS_RTC_HOSTS',
  'CALAB_IOS_APP_GROUP', 'CALAB_IOS_URL_SCHEME', 'EXPO_PUBLIC_CALAB_LINK_HOSTS'];
beforeEach(() => {
  vi.resetModules();
  for (const name of FLAGS) vi.stubEnv(name, '');
  vi.stubEnv('EXPO_PUBLIC_CALAB_URL', 'https://calab.example.com');
});
afterEach(() => vi.unstubAllEnvs());

const load = async () => (await import('../app.config')).default;
const calls = () => { vi.stubEnv('CALAB_IOS_INCOMING_CALLS', '1'); vi.stubEnv('CALAB_IOS_PUSH_ENVIRONMENT', 'development'); vi.stubEnv('CALAB_IOS_NATIVE_CALL_AUDIO', '1'); };
const room = (hosts = 'rtc.calab.ru') => { vi.stubEnv('CALAB_IOS_NATIVE_ROOM_AUDIO', '1'); vi.stubEnv('CALAB_IOS_RTC_HOSTS', hosts); };

it('builds either native audio driver on its own', async () => {
  room();
  await expect(load()).resolves.toBeTruthy();
  vi.resetModules();
  for (const name of FLAGS) vi.stubEnv(name, '');
  calls();
  expect((await load()).ios?.infoPlist?.CalabCallAudioEnabled).toBe(true);
});

it('refuses both drivers in one build until they share the engine owner', async () => {
  calls();
  room();
  await expect(load()).rejects.toThrow('cannot be combined');
});

it('refuses the room flag without rtc hosts', async () => {
  room('');
  await expect(load()).rejects.toThrow('CALAB_IOS_RTC_HOSTS');
});

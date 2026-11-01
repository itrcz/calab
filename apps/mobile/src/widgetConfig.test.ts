import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  for (const name of ['CALAB_IOS_APP_GROUP', 'CALAB_IOS_URL_SCHEME', 'CALAB_IOS_INCOMING_CALLS', 'CALAB_IOS_NATIVE_CALL_AUDIO', 'CALAB_IOS_PUSH_ENVIRONMENT', 'EXPO_PUBLIC_CALAB_LINK_HOSTS']) vi.stubEnv(name, '');
  vi.stubEnv('EXPO_PUBLIC_CALAB_URL', 'https://calab.example.com');
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  ['', '', ['calab', 'calaba']],
  ['group.example.calab', 'calab', ['calab', 'calaba']],
  ['group.example.widgetsdev', 'calab-widgets-dev', ['calab-widgets-dev']],
])('keeps product link aliases and isolates the custom widget scheme (%s, %s)', async (group, scheme, expected) => {
  vi.stubEnv('CALAB_IOS_APP_GROUP', group);
  vi.stubEnv('CALAB_IOS_URL_SCHEME', scheme);
  const { default: config } = await import('../app.config');
  expect(config.scheme).toEqual(expected);
  expect(config.ios?.associatedDomains).toContain('applinks:calab.example.com');
});

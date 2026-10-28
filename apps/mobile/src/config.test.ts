import { describe, expect, it } from 'vitest';
import { WebOriginError, parseWebOrigin, parseLinkHosts, parseReleaseIdentity } from './config';

describe('parseWebOrigin', () => {
  it('accepts a bare https origin, with or without the trailing slash or a port', () => {
    expect(parseWebOrigin('https://calab.example.com')).toBe('https://calab.example.com');
    expect(parseWebOrigin(' https://calab.example.com/ ')).toBe('https://calab.example.com');
    expect(parseWebOrigin('https://calab.example.com:8443')).toBe('https://calab.example.com:8443');
  });

  it.each([
    [undefined, 'not set'],
    ['', 'not set'],
    ['calab.example.com', 'not a valid URL'],
    ['http://calab.example.com', 'https'],
    ['wss://calab.example.com', 'https'],
    ['javascript:alert(1)', 'https'],
    ['file:///etc/hosts', 'https'],
    ['data:text/html,x', 'https'],
    ['https://user:pass@calab.example.com', 'credentials'],
    ['https://user@calab.example.com', 'credentials'],
  ])('rejects %j (%s)', (raw, message) => {
    expect(() => parseWebOrigin(raw)).toThrow(WebOriginError);
    expect(() => parseWebOrigin(raw)).toThrow(message);
  });

  it.each([
    'https://calab.example.com/app',
    'https://calab.example.com/?next=/x',
    'https://calab.example.com/#x',
    'https://calab.example.com:443',
    'https://Calab.Example.com',
    'https:\\\\calab.example.com',
    'https://calab.exa\tmple.com',
  ])('rejects %j that the URL parser would rewrite or truncate', (raw) => {
    expect(() => parseWebOrigin(raw)).toThrow('bare origin');
  });
});

describe('parseLinkHosts', () => {
  it('defaults to the host of the web origin, without its port, or to none', () => {
    expect(parseLinkHosts(undefined, 'https://calab.example.com')).toEqual(['calab.example.com']);
    expect(parseLinkHosts('  ', 'https://calab.example.com:8443')).toEqual(['calab.example.com']);
    expect(parseLinkHosts(undefined)).toEqual([]);
  });

  it('rejects an origin whose host is an IP or localhost, same as an explicit host (review follow-up)', () => {
    expect(() => parseLinkHosts(undefined, 'https://127.0.0.1:8443')).toThrow('EXPO_PUBLIC_CALAB_URL');
    expect(() => parseLinkHosts('  ', 'https://localhost:8443')).toThrow('EXPO_PUBLIC_CALAB_URL');
  });

  it('takes space-separated hostnames as given, once each, instead of the default', () => {
    expect(parseLinkHosts(' calab.example.com  alias.example.ru\tcalab.example.com ', 'https://other.example.com'))
      .toEqual(['calab.example.com', 'alias.example.ru']);
    expect(parseLinkHosts('xn--80ak6aa92e.example.com')).toEqual(['xn--80ak6aa92e.example.com']);
  });

  it.each([
    'Calab.example.com', 'calab.example.com:443', 'https://calab.example.com', 'calab.example.com/', 'calab.example.com/t/',
    '*.example.com', 'localhost', '127.0.0.1', 'calab..example.com', '-calab.example.com', 'calab-.example.com',
    'calab_x.example.com', 'calab.example.com.', 'user@calab.example.com', 'calab.example.com,alias.example.com',
    `${'a'.repeat(64)}.example.com`, 'calab.example.com\\x', 'кала.example.com',
  ])('rejects %j', (raw) => {
    expect(() => parseLinkHosts(`calab.example.com ${raw}`, 'https://calab.example.com')).toThrow('EXPO_PUBLIC_CALAB_LINK_HOSTS');
  });
});

describe('parseReleaseIdentity', () => {
  it('defaults locally and preserves explicit distribution identity', () => {
    expect(parseReleaseIdentity()).toEqual({ version: '0.1.0', buildNumber: '1' });
    expect(parseReleaseIdentity('4.2.3', '21')).toEqual({ version: '4.2.3', buildNumber: '21' });
  });
  it.each(['', '1.2', 'v1.2.3', '1.2.3-beta', '1.2.3.4', '01.2.3', '1.2.3\n'])('rejects malformed version %j', (version) => {
    expect(() => parseReleaseIdentity(version, '21')).toThrow('CALAB_APP_VERSION');
  });
  it.each(['', '0', '-1', '01', '1.2', '1e3', '10000', '21\n'])('rejects malformed build %j', (build) => {
    expect(() => parseReleaseIdentity('1.2.3', build)).toThrow('CALAB_IOS_BUILD_NUMBER');
  });
});

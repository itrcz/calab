import { describe, expect, it } from 'vitest';
import { WebOriginError, parseWebOrigin } from './config';

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

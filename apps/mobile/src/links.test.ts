import { describe, expect, it } from 'vitest';
import { appUrlForLink } from './links';

const origin = 'https://calab.example.com';
const hosts = ['calab.example.com', 'alias.example.ru'];
const B = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const open = (raw: string) => appUrlForLink(raw, origin, hosts);

describe('appUrlForLink', () => {
  it.each([
    ['https://calab.example.com/t/INV-820', '/t/INV-820'],
    ['https://alias.example.ru/t/INV-820/', '/t/INV-820'],
    ['https://Calab.Example.com/join/AbC123xYz?utm_source=tg#x', '/join/AbC123xYz'],
    ['https://calab.example.com/r/room_code-1#frag', '/r/room_code-1'],
    ['calab://t/INV-820', '/t/INV-820'],
    ['calab://join/AbC123xYz/', '/join/AbC123xYz'],
    ['calaba://r/AbC123xYz?x=1', '/r/AbC123xYz'],
    ['CALAB://t/INV-820', '/t/INV-820'],
    [`https://calab.example.com/b/${B}`, `/b/${B}`],
    [`https://calab.example.com/b/${B}/?utm=x`, `/b/${B}`],
    [`calab://b/${B}`, `/b/${B}`],
    [`https://calab.example.com/m/${B}/${M}#x`, `/m/${B}/${M}`],
    [`calab://m/${B}/${M}/`, `/m/${B}/${M}`],
    [`https://calab.example.com/wiki/${B}`, `/wiki/${B}`],
    [`calaba://wiki/${B}`, `/wiki/${B}`],
    [`https://calab.example.com/canvas/${B}`, `/canvas/${B}`],
    [`calab://canvas/${B}`, `/canvas/${B}`],
    [`https://calab.example.com/e/${B}`, `/e/${B}`],
    [`calab://e/${B}`, `/e/${B}`],
    [`https://calab.example.com/disk/${M}`, `/disk/${M}`],
    [`calab://disk/${M}/`, `/disk/${M}`],
  ])('maps %j to the app origin', (raw, route) => {
    expect(open(raw)).toBe(`${origin}${route}`);
  });

  it.each([
    '',
    'INV-820',
    '/t/INV-820',
    'http://calab.example.com/t/INV-820',
    'https://evil.example.com/t/INV-820',
    'https://calab.example.com.evil.test/t/INV-820',
    'https://calab.example.com@evil.test/t/INV-820',
    'https://user:pass@calab.example.com/t/INV-820',
    'https://user@calab.example.com/t/INV-820',
    'https://calab.example.com:443/t/INV-820',
    'https://calab.example.com:8443/t/INV-820',
    'https:/calab.example.com/t/INV-820',
    'https:\\\\calab.example.com/t/INV-820',
    'https://calab.example.com\\t\\INV-820',
    'https://calab.example.com/',
    'https://calab.example.com/t/',
    'https://calab.example.com/t/abc',
    `https://calab.example.com/t/${'a'.repeat(65)}`,
    'https://calab.example.com/t/INV-820/x',
    'https://calab.example.com/t/slug-not-a-task-key', // valid invite-code slug, not a task key (review follow-up)
    'https://calab.example.com/t//INV-820',
    'https://calab.example.com/T/INV-820',
    'https://calab.example.com/t/INV%2D820',
    'https://calab.example.com/t/INV.820',
    'https://calab.example.com/t/INV-820\n',
    'https://calab.example.com/b/BOARD1',
    'https://calab.example.com/b/11111111-1111-4111-8111-11111111111', // 35 chars
    'https://calab.example.com/b/11111111-1111-4111-8111-1111111111111', // 37 chars
    'https://calab.example.com/b/11111111-1111-4111-8111-11111111111g',
    `https://calab.example.com/b/${B}/x`,
    `https://calab.example.com/m/${B}`,
    `https://calab.example.com/m/${B}/BOARD1`,
    `https://calab.example.com/m/${B}/${M}/x`,
    'https://calab.example.com/wiki/page1',
    'https://calab.example.com/canvas/AbC123xYz',
    'https://calab.example.com/e/AbC123xYz',
    `https://calab.example.com/e/${B}/rsvp`,
    'https://calab.example.com/disk/42',
    `https://calab.example.com/c/${B}`,
    `https://calab.example.com/d/${B}`,
    'calab://m/abc',
    'calab://disk/42',
    'calab://wiki/abc',
    'https://calab.example.com/dm/AbC123xYz',
    'https://calab.example.com/plans?plan=team',
    'https://calab.example.com/../t/INV-820',
    ' https://calab.example.com/t/INV-820',
    'calab:///t/INV-820',
    'calab:t/INV-820',
    'calab://mail/payload',
    'calab://sso/callback?ticket=x',
    'calab://user@t/INV-820',
    'calab://t:1/INV-820',
    'calab://b/BOARD1',
    'calabx://t/INV-820',
    'javascript://t/INV-820',
    'file://calab.example.com/t/INV-820',
    'exp://calab.example.com/t/INV-820',
  ])('rejects %j', (raw) => {
    expect(open(raw)).toBeNull();
  });

  it('accepts https only from the configured hosts', () => {
    expect(appUrlForLink('https://alias.example.ru/t/INV-820', origin, ['calab.example.com'])).toBeNull();
    expect(appUrlForLink('https://calab.example.com/t/INV-820', origin, [])).toBeNull();
    expect(appUrlForLink('calab://t/INV-820', origin, [])).toBe(`${origin}/t/INV-820`);
  });
});

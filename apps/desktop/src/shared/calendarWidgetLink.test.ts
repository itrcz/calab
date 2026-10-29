import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCalendarWidgetAction, parseCalendarWidgetLink } from './calendarWidgetLink';

describe('calendar widget destinations', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('parses production links without URL or URLSearchParams, as required by Hermes', () => {
    vi.stubGlobal('URL', undefined);
    vi.stubGlobal('URLSearchParams', undefined);
    const url = 'calab://calendar?kind=event&day=2026-11-01&event=11111111-1111-4111-8111-111111111111&workspace=22222222-2222-4222-8222-222222222222&start=2026-11-01T09%3A00%3A00Z';
    expect(parseCalendarWidgetLink(url, 'calab')).toEqual({ kind: 'event', day: '2026-11-01', event: '11111111-1111-4111-8111-111111111111', workspace: '22222222-2222-4222-8222-222222222222', start: '2026-11-01T09:00:00Z' });
    // URLComponents leaves timestamp colons unescaped in native widget links.
    expect(parseCalendarWidgetLink(url.replaceAll('%3A', ':'), 'calab')).toEqual(parseCalendarWidgetLink(url, 'calab'));
    for (const bad of [url + '&%64ay=2026-11-02', url + '&__proto__=x', url + '&', url.replace('%3A', '%ZZ'), url.replace('//calendar', '//user@calendar'), url.replace('//calendar', '//calendar:80'), url.replace('//calendar', '//calendar/extra'), url + '\n']) expect(parseCalendarWidgetLink(bad, 'calab')).toBeNull();
  });
  it('keeps the occurrence and day, and rejects foreign origins or ambiguous queries', () => {
    const url = 'calab://calendar?kind=event&day=2026-11-01&event=11111111-1111-4111-8111-111111111111&workspace=22222222-2222-4222-8222-222222222222&start=2026-11-01T09%3A00%3A00Z';
    expect(parseCalendarWidgetLink(url, 'calab')).toMatchObject({ kind: 'event', day: '2026-11-01', start: '2026-11-01T09:00:00Z' });
    for (const bad of [url.replace('calab:', 'other:'), url.replace('//calendar', '//calendar.evil'), url + '&day=2026-11-02', url + '&url=https://evil.example', url + '#fragment', url.replace('2026-11-01&', '2026-02-30&')]) expect(parseCalendarWidgetLink(bad, 'calab')).toBeNull();
    expect(parseCalendarWidgetLink('calab://calendar?kind=create&day=2026-11-01', 'calab')).toEqual({ kind: 'create', day: '2026-11-01' });
    expect(parseCalendarWidgetAction({ kind: 'external', day: '2026-11-01', uid: '0123456789abcdef', start: 'invalid' })).toBeNull();
  });
});

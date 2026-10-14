import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBotRoutes, routeGroup, routesJson, ROUTES_OUTPUT, ROUTES_SOURCE } from '../../../../tools/gen-bot-routes';
import { compileDocs, getDocs, type Nav, type SourceFile } from './docs';
import { expandDirectives, type BotRoute } from './docs-markdown';

const nav: Nav = [
  { slug: 'bots', section: { ru: 'Боты', en: 'Bots' }, pages: [
    { slug: 'index', ru: 'Обзор', en: 'Overview' },
    { slug: 'quickstart', ru: 'Старт', en: 'Quickstart' },
  ] },
  { slug: 'oauth', section: { ru: 'OAuth', en: 'OAuth' }, pages: [{ slug: 'flow', ru: 'Поток', en: 'Flow' }] },
];
const routes: BotRoute[] = [
  { method: 'GET', path: '/api/boards/{id}', decision: 'allow', group: 'boards' },
  { method: 'POST', path: '/api/boards/{id}/tasks', decision: 'allow', group: 'boards' },
  { method: 'GET', path: '/api/me/sessions', decision: 'deny', group: 'profile' },
];
const file = (slug: string, body: string, lang: 'ru' | 'en' = 'en'): SourceFile => ({
  lang, slug, path: `docs/${lang}/${slug}.md`, lastModified: '2026-10-14T00:00:00Z',
  source: `---\ntitle: "${slug}"\ndescription: "About ${slug}"\n---\n\n${body}\n`,
});
const site = (extra: string) => compileDocs([
  file('bots/index', 'Start with the [quickstart](./quickstart).'),
  file('bots/quickstart', `## First request\n\n${extra}`),
  file('oauth/flow', '## How the flow works\n\nText.'),
], nav, routes);

describe('docs link check', () => {
  it('accepts page, folder (index.md) and anchor links', async () => {
    const s = await site('See [flow](../oauth/flow#how-the-flow-works), [bots](../bots), [top](#first-request), [x](https://example.com).');
    expect(s.urls).toEqual(['bots', 'oauth', 'bots/quickstart', 'oauth/flow']);
    const html = s.page('ru', 'bots/quickstart')?.entry.html ?? '';
    expect(html).toContain('href="/~/docs/oauth/flow/#how-the-flow-works"');
    expect(html).toContain('href="/~/docs/bots/"');
    expect(s.page('ru', 'bots/quickstart')?.notice).toBe('Эта страница пока только по-английски.');
  });
  it('fails the build on a missing page', async () => {
    await expect(site('[gone](../oauth/missing)')).rejects.toThrow(/broken link "\.\.\/oauth\/missing"/);
  });
  it('fails the build on a missing anchor', async () => {
    await expect(site('[flow](../oauth/flow#nope)')).rejects.toThrow(/broken anchor/);
  });
  it('fails the build on a file outside nav.ts and on an empty label', async () => {
    const broken: Nav = nav.map((s, i) => (i === 0 ? { ...s, section: { ru: '', en: 'Bots' } } : s));
    await expect(compileDocs([file('bots/index', 'x'), file('bots/quickstart', 'x'), file('oauth/flow', 'x'), file('oauth/extra', 'x')], broken, routes))
      .rejects.toThrow(/no ru label[\s\S]*not listed in nav\.ts/);
  });
  it('keeps Cyrillic anchors like GitHub', async () => {
    const s = await compileDocs([
      file('bots/index', 'x', 'ru'),
      file('bots/quickstart', '## Первый запрос\n\n[Поток](../oauth/flow#как-устроен-поток)', 'ru'),
      file('oauth/flow', '## Как устроен поток\n\nТекст.', 'ru'),
    ], nav, routes);
    expect(s.page('ru', 'bots/quickstart')?.entry.toc[0]?.id).toBe('первый-запрос');
  });
});

describe('route tables', () => {
  const block = (spec: string, rows: string) => `<!-- routes:${spec} -->\n| Метод | Путь | Что делает |\n|---|---|---|\n${rows}<!-- /routes -->`;
  it('regenerates rows and keeps hand-written descriptions', () => {
    const out = expandDirectives(block('boards', '| `GET` | `/api/boards/{id}` | Доска |\n'), routes, 'ru');
    expect(out).toContain('| `GET` | `/api/boards/{id}` | Доска |');
    expect(out).toContain('| `POST` | `/api/boards/{id}/tasks` | — |');
    expect(out).toContain('| Метод | Путь | Что делает |');
  });
  it('fails on an empty group and on a stale row', () => {
    expect(() => expandDirectives(block('allow:wiki', ''), routes, 'ru')).toThrow(/no routes/);
    expect(() => expandDirectives(block('boards', '| `GET` | `/api/old` | x |\n'), routes, 'ru')).toThrow(/not in botroutes\.go/);
  });
});

describe('gen-bot-routes', () => {
  it('parses the map literal', () => {
    const go = `var botRoutes = map[string]botAccess{\n\t"GET /api/boards/{id}": botAllow, // c\n\t// comment\n\t"/api/": botPublic,\n\t"POST /api/me/password": botDeny,\n}\n`;
    expect(parseBotRoutes(go)).toEqual([
      { method: 'GET', path: '/api/boards/{id}', decision: 'allow', group: 'boards' },
      { method: 'POST', path: '/api/me/password', decision: 'deny', group: 'profile' },
      { method: '*', path: '/api/', decision: 'public', group: 'system' },
    ]);
    expect(routeGroup('/api/tasks/{id}/watchers')).toBe('boards');
  });
  it('_routes.json matches botroutes.go (run `pnpm -F @calaba/landing gen:routes`)', () => {
    expect(readFileSync(ROUTES_OUTPUT, 'utf8')).toBe(routesJson(parseBotRoutes(readFileSync(ROUTES_SOURCE, 'utf8'))));
  });
});

describe('content', () => {
  it('the real docs build without errors', async () => {
    const s = await getDocs();
    expect(s.pageUrls.length).toBeGreaterThan(10);
  }, 60_000);
});

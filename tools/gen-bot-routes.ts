// Generates apps/landing/src/content/docs/_routes.json from the bot route table
// (apps/server/internal/app/botroutes.go, ADR-0031 / ADR-0099 §2): every server route with the
// decision for bot tokens and a docs group. The docs pages render a group's table with the
// `<!-- routes:group=boards -->` directive. Run: `pnpm -F @calaba/landing gen:routes`
// (also the landing `prebuild`); CI fails on drift (`git diff --exit-code`). `--check` only compares.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Decision = 'allow' | 'deny' | 'public';
export type BotRoute = { method: string; path: string; decision: Decision; group: string };

const DECISIONS: Record<string, Decision> = { botAllow: 'allow', botDeny: 'deny', botPublic: 'public' };

// Groups are the areas of the docs (`<!-- routes:<group> -->` markers in apps/landing/src/content/docs):
// boards = boards + tasks, rooms = rooms + voice + sounds, profile = /api/me + /api/bots/me.
// First match wins: more specific rules go first. A path that matches nothing is `other`.
const GROUP_RULES: [RegExp, string][] = [
  [/^\/(?:oidc\/|\.well-known\/oauth)|\/oauth(?:\/|-grants)|^\/api\/oauth\//, 'oauth'],
  [/\/identity(?:\/|$)|^\/api\/auth\/sso\//, 'sso'],
  [/^\/api\/auth\//, 'auth'],
  [/^\/api\/admin\//, 'admin'],
  [/\/billing(?:\/|$)/, 'billing'],
  [/sticker/, 'stickers'],
  [/^\/api\/bots\/me(?:\/|$)|\/bot-commands$/, 'profile'],
  [/^\/api\/bots\/|\/bots(?:\/|$)|\/blocked-bots/, 'bots'],
  [/forms(?:\/|$)/, 'forms'],
  [/\/disk(?:\/|$)/, 'disk'],
  [/\/wiki(?:\/|$)/, 'wiki'],
  [/^\/api\/notes(?:\/|$)/, 'notes'],
  [/^\/api\/(?:tasks|t|checklists|checklist-items|task-milestones|boards|board-categories|rules|git)\/|^\/api\/me\/tasks$|\/tasks\/search$|\/boards(?:\/order)?$|\/board-categories$/, 'boards'],
  [/\/search$|^\/api\/me\/mentions$/, 'search'],
  [/^\/api\/(?:events|event-rsvp)(?:\/|$)|\/events(?:\/|$)|\/freebusy|\/caldav|\/external-events/, 'calendar'],
  [/^\/api\/dms(?:\/|$)/, 'dm'],
  [/^\/api\/mailbox(?:\/|$)/, 'mailbox'],
  [/\/messages(?:\/|$)|^\/api\/messages\/|\/pins$|^\/api\/unfurl|\/rooms\/\{[^}]+\}\/read$|\/transcript$/, 'messages'],
  [/\/voice|^\/api\/rooms\/\{[^}]+\}\/join$|\/stream\/|\/camera\/|\/sounds(?:\/|$)|\/recording|\/admissions|\/calls(?:\/|$)|^\/api\/rtc\/|\/rooms(?:\/|$)|^\/api\/rooms\/|\/categories(?:\/|$)|^\/api\/categories\//, 'rooms'],
  [/\/files(?:\/|$)|^\/api\/files\//, 'files'],
  [/\/(?:members|roles|bans|badges|invites|birthdays|achievements)(?:\/|$)|^\/api\/invites\/|^\/api\/room-invites\/|^\/api\/workspaces(?:\/\{[^}]+\})?$/, 'members'],
  [/^\/api\/me(?:\/|$)|^\/api\/users\/|^\/api\/usernames\//, 'profile'],
  [/^\/api\/workspaces(?:\/|$)|^\/api\/workspace-apps\//, 'workspaces'],
  [/^\/(?:gateway|healthz|readyz|metrics)$|^\/api\/version$|^\/api\/$/, 'system'],
];

export const routeGroup = (path: string): string => GROUP_RULES.find(([re]) => re.test(path))?.[1] ?? 'other';

const ORDER: Record<string, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4, OPTIONS: 5, '*': 6 };

/** Parses the `botRoutes` map literal of botroutes.go. Throws when the map is missing or empty. */
export function parseBotRoutes(source: string): BotRoute[] {
  const start = source.indexOf('var botRoutes = map[string]botAccess{');
  if (start < 0) throw new Error('botroutes.go: `var botRoutes = map[string]botAccess{` not found');
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const routes: BotRoute[] = [];
  const line = /^\s*"(?:([A-Z]+) )?([^"\s]+)":\s*(botAllow|botDeny|botPublic)\s*,/gm;
  for (const m of body.matchAll(line)) {
    const [, method = '*', path = '', access = ''] = m;
    const decision = DECISIONS[access];
    if (decision === undefined) continue;
    routes.push({ method, path, decision, group: routeGroup(path) });
  }
  if (routes.length === 0) throw new Error('botroutes.go: no routes parsed');
  return routes.sort((a, b) =>
    a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || (ORDER[a.method] ?? 9) - (ORDER[b.method] ?? 9));
}

// One route per line: readable diffs in review and in the CI drift check.
export const routesJson = (routes: BotRoute[]): string => `[\n${routes.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROUTES_SOURCE = resolve(repo, 'apps/server/internal/app/botroutes.go');
export const ROUTES_OUTPUT = resolve(repo, 'apps/landing/src/content/docs/_routes.json');

function main(): void {
  const json = routesJson(parseBotRoutes(readFileSync(ROUTES_SOURCE, 'utf8')));
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(ROUTES_OUTPUT, 'utf8'); } catch { /* missing = drift */ }
    if (current !== json) {
      console.error('_routes.json is out of date: run `pnpm -F @calaba/landing gen:routes`');
      process.exit(1);
    }
    return;
  }
  writeFileSync(ROUTES_OUTPUT, json);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

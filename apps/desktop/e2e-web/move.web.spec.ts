import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * TESTING.md M.1 — a moderator moves a participant to another voice room (ADR-0019: app-level
 * move on open-source LiveKit: VOICE_MOVED carries a join token for the target room and the
 * moved device reconnects itself).
 *
 * Two accounts in one test: A (CALABA_WEB_LOGIN / CALABA_WEB_PASSWORD) is an admin of the
 * workspace, B (CALABA_WEB_LOGIN2 / CALABA_WEB_PASSWORD2) a member. Without them the mock
 * fixtures are used (owner@ / vera@calaba.test). Idempotent on the stand: the workspace
 * (CALABA_WEB_WORKSPACE, default «E2E web»), the voice rooms «Созвон» / «Созвон 2» and B's
 * membership (through a reusable invite of A) are created only when missing.
 * Voice in Firefox is opt-in (CALABA_WEB_FF_VOICE=1), as in app.web.spec.ts.
 */

const env = (name: string): string | undefined => process.env[name] || undefined;
const WS_NAME = env('CALABA_WEB_WORKSPACE') ?? 'E2E web';
const FROM = 'Созвон';
const TO = 'Созвон 2';
// Mock fixtures (e2e-support/fixtures.ts): the owner and a plain member.
const A = { login: env('CALABA_WEB_LOGIN') ?? 'owner@calaba.test', password: env('CALABA_WEB_PASSWORD') ?? 'password123' };
const B = { login: env('CALABA_WEB_LOGIN2') ?? 'vera@calaba.test', password: env('CALABA_WEB_PASSWORD2') ?? 'password123' };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Client {
  ctx: BrowserContext;
  page: Page;
  /** REST call with this client's access token (taken from the app's own requests). */
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

async function signIn(browser: Browser, baseURL: string | undefined, who: { login: string; password: string }): Promise<Client> {
  // browser.newContext() does not take the project's `use` options: pass the base URL on.
  const ctx = await browser.newContext(baseURL ? { baseURL } : {});
  const page = await ctx.newPage();
  // The web client keeps the access token in memory only: pick it up from its API requests.
  let token = '';
  page.on('request', (r) => {
    const h = r.headers()['authorization'];
    if (h?.startsWith('Bearer ')) token = h;
  });
  await page.goto('/');
  await page.getByLabel('Email').fill(who.login);
  await page.getByLabel('Пароль', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  // First run on this device: onboarding (docs/08) — skip it, it has its own visual tests.
  const skip = page.getByRole('button', { name: 'Пропустить настройку' });
  const rail = page.getByRole('navigation', { name: 'Разделы' });
  await expect(skip.or(rail)).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(rail).toBeVisible();
  await expect.poll(() => token, { message: 'access token seen in API requests' }).not.toBe('');
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await page.request.fetch(path, {
      method,
      headers: { Authorization: token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { data: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status(), json: text ? (JSON.parse(text) as unknown) : {} };
  };
  return { ctx, page, api };
}

interface Workspace {
  id: string;
  name: string;
}

async function findWorkspace(c: Client): Promise<Workspace | undefined> {
  const json = (await c.api('GET', '/api/workspaces')).json as { workspaces?: Workspace[] };
  return (json.workspaces ?? []).find((w) => w.name === WS_NAME);
}

/** Opens the workspace in the title bar's switcher (ADR-0074); creates it through the UI when A has none (the server derives the slug). */
async function openWorkspace(c: Client, createIfMissing: boolean): Promise<void> {
  await c.page.getByTestId('titlebar-title').click();
  if (createIfMissing && (await findWorkspace(c)) === undefined) {
    await c.page.getByRole('menuitem', { name: 'Создать пространство' }).click();
    await c.page.getByRole('textbox', { name: 'Название', exact: true }).fill(WS_NAME);
    await c.page.getByRole('button', { name: 'Создать', exact: true }).click();
  } else {
    await c.page.getByRole('menuitem', { name: new RegExp(`^${escapeRe(WS_NAME)}\\b`) }).first().click();
  }
  // The room list of that workspace is on screen (an empty one offers «Создать комнату»).
  await expect(sidebar(c.page).getByRole('button', { name: 'Создать комнату' }).or(sidebar(c.page).getByRole('button', { name: FROM, exact: true })).first()).toBeVisible();
}

const sidebar = (page: Page) => page.locator('aside').first();
const voicePanel = (page: Page) => page.getByRole('region', { name: 'Голосовое подключение' });
/** The voice panel's room link reads «Комната / Пространство» (Discord); anchored so «Созвон» ≠ «Созвон 2». */
const panelRoom = (room: string): RegExp => new RegExp(`^${escapeRe(room)}( / |$)`);
/** Voice participants listed under a voice room in the room list. */
const participants = (page: Page, room: string) => sidebar(page).getByRole('list', { name: room, exact: true });

test('M.1: a moderator moves a participant to another voice room (ADR-0019)', async ({ browser, browserName, baseURL }) => {
  test.skip(browserName === 'firefox' && process.env['CALABA_WEB_FF_VOICE'] !== '1', 'voice in Firefox: CALABA_WEB_FF_VOICE=1');

  const a = await signIn(browser, baseURL, A);
  const b = await signIn(browser, baseURL, B);
  try {
    // ---- setup (idempotent): workspace, both voice rooms, B's membership
    await openWorkspace(a, true);
    const ws = await findWorkspace(a);
    if (!ws) throw new Error(`A has no workspace «${WS_NAME}»`);
    const roomList = (await a.api('GET', `/api/workspaces/${ws.id}/rooms`)).json as { rooms?: { name: string; type: string }[] };
    for (const name of [FROM, TO]) {
      if ((roomList.rooms ?? []).some((r) => r.name === name && r.type === 'ROOM_TYPE_VOICE')) continue;
      const created = await a.api('POST', `/api/workspaces/${ws.id}/rooms`, { type: 'ROOM_TYPE_VOICE', name });
      expect(created.status, `create voice room «${name}»`).toBe(201);
    }

    if ((await findWorkspace(b))?.id !== ws.id) {
      const inv = (await a.api('GET', `/api/workspaces/${ws.id}/invites`)).json as { invites?: { code: string; maxUses: number; expiresAt?: string }[] };
      let code = (inv.invites ?? []).find((i) => i.maxUses === 0 && !i.expiresAt)?.code;
      if (!code) {
        const created = await a.api('POST', `/api/workspaces/${ws.id}/invites`, { maxUses: 0, expiresInSeconds: 0 });
        expect(created.status, 'create a reusable invite').toBe(201);
        code = (created.json as { invite: { code: string } }).invite.code;
      }
      const joined = await b.api('POST', `/api/invites/${encodeURIComponent(code)}/join`);
      expect([200, 409], 'B joins the workspace').toContain(joined.status);
    }
    const me = (await b.api('GET', '/api/me')).json as { me: { user: { id: string; displayName: string } } };
    const members = (await b.api('GET', `/api/workspaces/${ws.id}/members`)).json as { members?: { user?: { id: string }; nickname: string }[] };
    const bName = members.members?.find((m) => m.user?.id === me.me.user.id)?.nickname || me.me.user.displayName;

    // ---- B joins «Созвон» and turns on the media stats (mic bitrate = the mic is published)
    await openWorkspace(b, false);
    await sidebar(b.page).getByRole('button', { name: FROM, exact: true }).click();
    await expect(voicePanel(b.page).getByText('Голос подключён')).toBeVisible({ timeout: 30_000 });
    await expect(voicePanel(b.page).getByRole('button', { name: panelRoom(FROM) })).toBeVisible();
    const stats = b.page.getByTestId('media-stats');
    // «Статистика» is a checkbox item in the voice panel's «Ещё» menu (v0.2 panel, Discord layout).
    await voicePanel(b.page).getByRole('button', { name: 'Ещё', exact: true }).click();
    await b.page.getByRole('menuitemcheckbox', { name: 'Статистика' }).click();
    const micKbps = async (): Promise<number> => {
      const m = /mic (\d+(?:\.\d+)?) kbps/.exec((await stats.textContent().catch(() => null)) ?? '');
      return m ? Number(m[1]) : 0;
    };
    await expect.poll(micKbps, { message: 'B sends mic audio in «Созвон»', timeout: 15_000 }).toBeGreaterThan(0);

    // ---- A: B's menu in the room list → «Переместить в…» → «Созвон 2»
    await openWorkspace(a, false);
    const bRow = participants(a.page, FROM).getByRole('listitem', { name: new RegExp(`^${escapeRe(bName)}(\\.|$)`) });
    await expect(bRow).toBeVisible();
    await bRow.click({ button: 'right' });
    await a.page.getByRole('menuitem', { name: 'Переместить в…' }).click();
    // ADR-0019: B reconnects with the token from VOICE_MOVED, not through /join (that is the
    // fallback after an SFU move that did not happen).
    const rejoins: string[] = [];
    b.page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/rooms\/[^/]+\/join$/.test(new URL(r.url()).pathname)) rejoins.push(r.url());
    });
    const moved = a.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/rooms\/[^/]+\/voice\/[^/]+\/move$/.test(new URL(r.url()).pathname));
    await a.page.getByRole('menuitem', { name: TO, exact: true }).click();
    expect((await moved).status(), 'POST …/move').toBe(204);

    // ---- B: in «Созвон 2» within 10 s, the move toast, the mic published again
    const toast = b.page.getByText(new RegExp(`(переместил\\(а\\) вас|Вас переместили) в «${escapeRe(TO)}»`));
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(voicePanel(b.page).getByRole('button', { name: panelRoom(TO) })).toBeVisible({ timeout: 10_000 });
    await expect(voicePanel(b.page).getByText('Голос подключён')).toBeVisible({ timeout: 10_000 });
    // Stats are reset when the old connection is torn down, so a bitrate now is the new mic's.
    await expect.poll(micKbps, { message: 'B sends mic audio in «Созвон 2»', timeout: 10_000 }).toBeGreaterThan(0);
    expect(rejoins, 'B joined the target room with the VOICE_MOVED token').toEqual([]);
    await expect(participants(b.page, TO).getByRole('listitem', { name: new RegExp(`^${escapeRe(bName)}(\\.|$)`) })).toBeVisible();

    // ---- A: B is listed under «Созвон 2», no longer under «Созвон»
    await expect(participants(a.page, TO).getByRole('listitem', { name: new RegExp(`^${escapeRe(bName)}(\\.|$)`) })).toBeVisible({ timeout: 10_000 });
    await expect(bRow).toHaveCount(0);
  } finally {
    // Cleanup: leave voice (A never joined; «Отключиться» only exists while in a call).
    for (const c of [b, a]) {
      const leave = voicePanel(c.page).getByRole('button', { name: 'Отключиться' });
      if (await leave.isVisible().catch(() => false)) {
        await leave.click();
        await expect(voicePanel(c.page)).toHaveCount(0);
      }
    }
    await a.ctx.close();
    await b.ctx.close();
  }
});

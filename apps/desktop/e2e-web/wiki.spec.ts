import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as Y from 'yjs';

/**
 * Wiki against the REAL Go server (W7, docs/plans/wiki-v1-tasks.md «Проверка W7»): two browser
 * contexts = two members of one workspace edit one page through the sync socket. Needs the server
 * with REGISTRATION_MODE=open and the web build served same-origin with the API:
 *   CALABA_WIKI_REAL=1 CALABA_WEB_URL=http://localhost:4177 pnpm e2e:web --project=chromium wiki.spec.ts
 * (setup commands in the plan). Skipped otherwise — the mock has its own checks (services/wiki.wire.test.ts).
 */
test.skip(!process.env['CALABA_WIKI_REAL'], 'real server only (CALABA_WIKI_REAL=1)');

const PASSWORD = 'w7-password-1';
/** `GET /api/public/wiki/{code}/state` (docs/05): records `u32 BE length | frame`, a SNAPSHOT then UPDATEs (frame = type | u64 seq | Yjs update). */
function stateUpdates(body: Uint8Array): Uint8Array[] | null {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: Uint8Array[] = [];
  for (let at = 0; at < body.length; ) {
    if (at + 4 > body.length) return null;
    const len = dv.getUint32(at);
    const frame = body.subarray(at + 4, at + 4 + len);
    if (frame.length !== len || len < 9 || (frame[0] !== 0 && frame[0] !== 1)) return null;
    out.push(frame.subarray(9));
    at += 4 + len;
  }
  return out;
}

const SYNC_MS = 2000; // the task's bound: B sees A's text within 2 s

interface Person {
  email: string;
  name: string;
  token: string;
}

const json = { 'content-type': 'application/json' };

async function register(request: APIRequestContext, name: string, stamp: string): Promise<Person> {
  const email = `w7-${name.toLowerCase()}-${stamp}@example.com`;
  const r = await request.post('/api/auth/register', { data: { email, password: PASSWORD, displayName: name }, headers: json });
  expect(r.ok(), await r.text()).toBe(true);
  return { email, name, token: ((await r.json()) as { tokens: { accessToken: string } }).tokens.accessToken };
}

const auth = (p: Person): Record<string, string> => ({ authorization: `Bearer ${p.token}`, ...json });

async function signIn(page: Page, p: Person): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(p.email);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const skip = page.getByRole('button', { name: 'Пропустить настройку' });
  const rail = page.getByRole('navigation', { name: 'Разделы' });
  await expect(skip.or(rail)).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(rail).toBeVisible();
}

async function openWiki(page: Page): Promise<void> {
  await page.getByTestId('section-wiki').click();
  await expect(page.getByTestId('wiki')).toBeVisible();
}

const editor = (page: Page) => page.locator('.wiki-prose');

/** The document text without the remote carets' name labels (they are inside the editor's DOM). */
const docText = (page: Page): Promise<string> =>
  editor(page).evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.wiki-caret').forEach((n) => n.remove());
    return c.textContent.replace(/\u200b|\ufeff/g, '');
  });

/** Types at the end of the document (the caret goes to the end first). */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text, { delay: 15 });
}

async function member(browser: Browser, p: Person): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ locale: 'ru-RU' });
  const page = await ctx.newPage();
  await signIn(page, p);
  return { ctx, page };
}

test('two members edit one page: convergence, awareness, compaction, versions, public link', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString(36);
  const a = await register(request, 'Alice', stamp);
  const b = await register(request, 'Boris', stamp);
  const ws = ((await (await request.post('/api/workspaces', { headers: auth(a), data: { slug: `w7-${stamp}`, name: 'W7' } })).json()) as { workspace: { id: string } }).workspace.id;
  const code = ((await (await request.post(`/api/workspaces/${ws}/invites`, { headers: auth(a), data: {} })).json()) as { invite: { code: string } }).invite.code;
  expect((await request.post(`/api/invites/${code}/join`, { headers: auth(b), data: {} })).ok()).toBe(true);

  const A = await member(browser, a);
  const B = await member(browser, b);
  const pa = A.page;
  const pb = B.page;
  const log: string[] = [];
  const timed = async (what: string, f: () => Promise<void>): Promise<void> => {
    const t0 = Date.now();
    await f();
    log.push(`${what}: ${Date.now() - t0} ms`);
  };

  // B has the section open BEFORE A creates the page: it must arrive through WIKI_PAGE_UPSERT.
  await openWiki(pb);
  await openWiki(pa);
  await pa.getByTestId('wiki-new-page').click();
  const title = `Спека ${stamp}`;
  await expect(pa.getByTestId('wiki-title')).toBeVisible();
  await pa.getByTestId('wiki-title').fill(title);
  await pa.getByTestId('wiki-title').press('Enter');
  await expect(editor(pa)).toBeEditable();
  await editor(pa).pressSequentially('Привет от Алисы', { delay: 20 });

  // B: the page appears in the tree by the event (no reload), opens, shows A's text.
  const row = pb.getByTestId('wiki-node').filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByTestId('wiki-node-open').click();
  await timed('B sees A text', () => expect(editor(pb)).toContainText('Привет от Алисы', { timeout: SYNC_MS * 3 }));
  await expect(editor(pb)).toBeEditable(); // my_bits from the event (WIKI_WRITE) → the page is writable

  // B types; A sees it within 2 s.
  await typeAtEnd(pb, ' и Борис');
  const t0 = Date.now();
  await expect(editor(pa)).toContainText('Привет от Алисы и Борис', { timeout: SYNC_MS });
  log.push(`A sees B text: ${Date.now() - t0} ms`);

  // Awareness: each sees the other's name on a caret (A clicks to publish her cursor again) and in the coauthors.
  await editor(pa).click();
  await typeAtEnd(pa, '!');
  await expect(pb.locator('.wiki-caret-label', { hasText: 'Alice' })).toBeVisible({ timeout: 5000 });
  await typeAtEnd(pb, '?');
  await expect(pa.locator('.wiki-caret-label', { hasText: 'Boris' })).toBeVisible({ timeout: 5000 });
  await expect(pa.getByTestId('wiki-coauthors')).toBeVisible();
  await expect(pb.getByTestId('wiki-coauthors')).toBeVisible();
  // Convergence: both documents are the same string (the order of the two concurrent marks is the CRDT's).
  await expect.poll(() => docText(pa), { timeout: SYNC_MS }).toMatch(/^Привет от Алисы и Борис[!?]{2}$/);
  expect(await docText(pb)).toBe(await docText(pa));
  const converged = await docText(pa);

  // Compaction (idle ≥ 3 s on the editing client): the page row gets its preview and size.
  const pageId = new URL(pa.url()).searchParams.get('page') ?? '';
  const ids = ((await (await request.get(`/api/workspaces/${ws}/wiki/pages`, { headers: auth(a) })).json()) as { pages: Array<{ id: string; title: string }> }).pages;
  const id = ids.find((p) => p.title === title)?.id ?? pageId;
  expect(id).toBeTruthy();
  const t1 = Date.now();
  await expect
    .poll(async () => ((await (await request.get(`/api/wiki/pages/${id}`, { headers: auth(a) })).json()) as { page: { preview: string; docSize: string } }).page.preview, { timeout: 20_000 })
    .toContain('Привет от Алисы и Борис');
  log.push(`compaction visible in preview: ${Date.now() - t1} ms after the last key`);

  // Reload A: the content comes back from the server (snapshot + updates).
  await pa.reload();
  await expect(pa.getByRole('navigation', { name: 'Разделы' })).toBeVisible({ timeout: 20_000 });
  await openWiki(pa);
  await pa.getByTestId('wiki-node').filter({ hasText: title }).getByTestId('wiki-node-open').click();
  await expect.poll(() => docText(pa), { timeout: 15_000 }).toBe(converged);

  // History: the first compaction wrote a version (no earlier one, so the 5-minute rule did not apply).
  const versions = ((await (await request.get(`/api/wiki/pages/${id}/versions`, { headers: auth(a) })).json()) as { versions: Array<{ id: string; size: string; authorIds: string[] }> }).versions;
  expect(versions.length).toBeGreaterThanOrEqual(1);
  expect(versions[0]?.authorIds.length).toBeGreaterThanOrEqual(1);

  // Restore flow: A adds text, then restores the version in the dialog; B sees the restored text.
  await typeAtEnd(pa, ' ЛИШНЕЕ');
  await expect(editor(pb)).toContainText('ЛИШНЕЕ', { timeout: SYNC_MS });
  await pa.getByTestId('wiki-more').click();
  await pa.getByTestId('wiki-open-versions').click();
  await expect(pa.getByTestId('wiki-versions')).toBeVisible();
  await pa.getByTestId('wiki-version-row').first().click();
  await pa.getByTestId('wiki-version-restore').click();
  await expect.poll(() => docText(pa), { timeout: 5000 }).not.toContain('ЛИШНЕЕ');
  await expect.poll(() => docText(pa)).toBe(converged);
  await timed('B sees the restore', () => expect.poll(() => docText(pb), { timeout: SYNC_MS * 2 }).toBe(converged));

  // Public link: anonymous meta + state stream that parses to the page's text.
  const link = (await (await request.post(`/api/wiki/pages/${id}/link`, { headers: auth(a), data: { includeChildren: false } })).json()) as { link: { code: string }; url: string };
  expect(new URL(link.url).pathname).toBe(`/w/${link.link.code}`);
  await expect
    .poll(async () => {
      const st = await request.get(`/api/public/wiki/${link.link.code}/state`); // no auth header: the shared request context has none
      if (!st.ok()) return `HTTP ${st.status()}`;
      const doc = new Y.Doc();
      const updates = stateUpdates(new Uint8Array(await st.body()));
      if (!updates) return 'bad stream';
      for (const u of updates) Y.applyUpdate(doc, u);
      return doc.getXmlFragment('default').toJSON();
    })
    .toContain('Привет от Алисы и Борис');
  const meta = (await (await request.get(`/api/public/wiki/${link.link.code}`)).json()) as { title: string; id: string };
  expect(meta.title).toBe(title);

  console.log(`W7 timings\n  ${log.join('\n  ')}`);
  await A.ctx.close();
  await B.ctx.close();
});

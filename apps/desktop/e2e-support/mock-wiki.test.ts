import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { decodeFrame, encodeUpdate, FRAME_SNAPSHOT, FRAME_UPDATE, type Frame } from '../src/renderer/lib/wiki/frames';
import { IDS, startMockServer, type MockServer } from './mock-server';

// The Wiki in the mock (ADR-0096): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts mock-wiki

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email: string): Promise<string> {
  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceName: 'vitest' }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

const api = (token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

type Page = { id: string; title: string; parentId?: string; hasChildren?: boolean; restricted?: boolean; position?: number };
const W = `/api/workspaces/${IDS.workspaces.main}/wiki`;

/** A sync socket that collects decoded frames. */
function sync(pageId: string, token: string): Promise<{ ws: WebSocket; frames: Frame[]; next: () => Promise<Frame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/wiki/pages/${pageId}/sync`);
    const frames: Frame[] = [];
    const waiters: Array<(f: Frame) => void> = [];
    ws.on('message', (data: Buffer) => {
      const f = decodeFrame(new Uint8Array(data));
      if (!f) return;
      const w = waiters.shift();
      if (w) w(f);
      else frames.push(f);
    });
    ws.on('open', () => {
      ws.send(token);
      resolve({ ws, frames, next: () => new Promise((r) => (frames.length ? r(frames.shift() as Frame) : waiters.push(r))) });
    });
    ws.on('error', reject);
  });
}

describe('wiki (ADR-0096)', () => {
  it('the top level, lazy children, the restricted page only for the listed, the trash', async () => {
    const anna = await login('owner@calaba.test');
    const top = ((await (await api(anna, `${W}/pages`)).json()) as { pages: Page[] }).pages;
    expect(top.map((p) => p.title)).toEqual(['Справочник команды', 'Встречи', 'Черновики']);
    const handbook = top[0] as Page;
    expect(handbook.hasChildren).toBe(true);
    const kids = ((await (await api(anna, `${W}/pages?parent=${handbook.id}`)).json()) as { pages: Page[] }).pages;
    expect(kids.map((p) => p.title)).toEqual(['Онбординг', 'Процессы', 'Глоссарий']);
    const grigory = await login('grigory@calaba.test');
    const gTop = ((await (await api(grigory, `${W}/pages`)).json()) as { pages: Page[] }).pages;
    expect(gTop.some((p) => p.title === 'Черновики')).toBe(false);
    const trash = ((await (await api(anna, `${W}/pages?trashed=1`)).json()) as { pages: Page[] }).pages;
    expect(trash.map((p) => p.title)).toEqual(['Старый регламент', 'Заметки Q3']);
  });

  it('create → move with position → trash → restore', async () => {
    const anna = await login('owner@calaba.test');
    const top = ((await (await api(anna, `${W}/pages`)).json()) as { pages: Page[] }).pages;
    const made = ((await (await api(anna, `${W}/pages`, { method: 'POST', body: { title: 'Новая' } })).json()) as { page: Page }).page;
    const moved = ((await (await api(anna, `/api/wiki/pages/${made.id}`, { method: 'PATCH', body: { parentId: top[1]?.id, position: 0 } })).json()) as { page: Page }).page;
    expect(moved.parentId).toBe(top[1]?.id);
    const kids = ((await (await api(anna, `${W}/pages?parent=${top[1]?.id}`)).json()) as { pages: Page[] }).pages;
    expect(kids[0]?.title).toBe('Новая');
    expect((await api(anna, `/api/wiki/pages/${top[1]?.id}`, { method: 'PATCH', body: { parentId: made.id } })).status).toBe(422);
    expect((await api(anna, `/api/wiki/pages/${made.id}/trash`, { method: 'POST' })).status).toBe(200);
    expect((await api(anna, `/api/wiki/pages/${made.id}/restore`, { method: 'POST' })).status).toBe(200);
  });

  it('the sync socket: snapshot with the seeded document, updates echoed with a seq to every socket', async () => {
    const anna = await login('owner@calaba.test');
    const boris = await login('boris@calaba.test');
    const handbook = (((await (await api(anna, `${W}/pages`)).json()) as { pages: Page[] }).pages[0]) as Page;
    const a = await sync(handbook.id, anna);
    const b = await sync(handbook.id, boris);
    const snap = await a.next();
    await b.next();
    expect(snap.type).toBe(FRAME_SNAPSHOT);
    const doc = new Y.Doc();
    if (snap.type === FRAME_SNAPSHOT) Y.applyUpdate(doc, snap.state);
    const frag = doc.getXmlFragment('default');
    expect((frag.get(0) as Y.XmlElement).nodeName).toBe('heading');
    expect(frag.toJSON()).toContain('Первая неделя');
    // An edit from Anna reaches both sockets with seq 1.
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(doc));
    let update: Uint8Array | null = null;
    local.on('update', (u: Uint8Array) => (update = u));
    local.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    a.ws.send(encodeUpdate(update as unknown as Uint8Array));
    const [ea, eb] = await Promise.all([a.next(), b.next()]);
    expect(ea.type).toBe(FRAME_UPDATE);
    expect(eb.type === FRAME_UPDATE && eb.seq).toBe(1);
    a.ws.close();
    b.ws.close();
  });

  it('a page I cannot see closes the socket with 4003', async () => {
    const anna = await login('owner@calaba.test');
    const grigory = await login('grigory@calaba.test');
    const drafts = (((await (await api(anna, `${W}/pages`)).json()) as { pages: Page[] }).pages).find((p) => p.title === 'Черновики') as Page;
    const s = await sync(drafts.id, grigory);
    const code = await new Promise<number>((r) => s.ws.on('close', (c) => r(c)));
    expect(code).toBe(4003);
  });

  it('versions list and their binary state', async () => {
    const anna = await login('owner@calaba.test');
    const handbook = (((await (await api(anna, `${W}/pages`)).json()) as { pages: Page[] }).pages[0]) as Page;
    const vs = ((await (await api(anna, `/api/wiki/pages/${handbook.id}/versions`)).json()) as { versions: Array<{ id: string; plainText: string }> }).versions;
    expect(vs.length).toBe(2);
    const res = await api(anna, `/api/wiki/pages/${handbook.id}/versions/${vs[1]?.id}`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
    expect(doc.getXmlFragment('default').length).toBeGreaterThan(0);
  });
});

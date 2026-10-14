import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';

// The Disk in the mock (ADR-0094): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

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

type Item = { id: string; name: string; kind: string; restricted?: boolean; myBits?: string; trashedAt?: string; link?: { code: string } };
const W = `/api/workspaces/${IDS.workspaces.main}/disk`;

describe('disk (ADR-0094)', () => {
  it('the root lists folders first; a restricted folder only for the listed; the trash; usage', async () => {
    const anna = await login('owner@calaba.test');
    const root = ((await (await api(anna, `${W}/items`)).json()) as { items: Item[] }).items;
    expect(root.slice(0, 4).map((i) => i.name)).toEqual(['Дизайн', 'Договоры', 'Проекты', 'Бюджет 2026.xlsx']);
    expect(root.find((i) => i.name === 'Демо продукта.mp4')?.link?.code).toBeTruthy();
    const vera = await login('vera@calaba.test');
    const veraRoot = ((await (await api(vera, `${W}/items`)).json()) as { items: Item[] }).items;
    expect(veraRoot.some((i) => i.name === 'Договоры')).toBe(true);
    const grigory = await login('grigory@calaba.test');
    const gRoot = ((await (await api(grigory, `${W}/items`)).json()) as { items: Item[] }).items;
    expect(gRoot.some((i) => i.name === 'Договоры')).toBe(false);
    const trash = ((await (await api(anna, `${W}/items?trashed=1`)).json()) as { items: Item[] }).items;
    expect(trash.map((i) => i.name)).toEqual(['Старый макет.png', 'Черновик договора.docx']);
    const usage = (await (await api(anna, `${W}/usage`)).json()) as { quotaBytes: string; trashBytes: string; diskBytes: string; otherBytes: string };
    expect(Number(usage.quotaBytes)).toBe(10 * 1024 ** 3);
    expect(Number(usage.trashBytes)).toBeGreaterThan(0);
    expect(Number(usage.otherBytes)).toBeGreaterThan(0);
  });

  it('folder → rename → move → trash → restore, with the journal', async () => {
    const anna = await login('owner@calaba.test');
    const made = ((await (await api(anna, `${W}/folders`, { method: 'POST', body: { name: 'Проекты' } })).json()) as { item: Item }).item;
    expect(made.name).toBe('Проекты (2)');
    const renamed = ((await (await api(anna, `/api/disk/items/${made.id}`, { method: 'PATCH', body: { name: 'Архив' } })).json()) as { item: Item }).item;
    expect(renamed.name).toBe('Архив');
    const trashed = ((await (await api(anna, `/api/disk/items/${made.id}/trash`, { method: 'POST' })).json()) as { item: Item }).item;
    expect(trashed.trashedAt).toBeTruthy();
    const back = ((await (await api(anna, `/api/disk/items/${made.id}/restore`, { method: 'POST' })).json()) as { item: Item }).item;
    expect(back.trashedAt).toBeUndefined();
    const log = (await (await api(anna, `/api/disk/items/${made.id}/activity`)).json()) as { activities: Array<{ kind: string }> };
    expect(log.activities.map((a) => a.kind)).toEqual(['DISK_ACTIVITY_KIND_RESTORE', 'DISK_ACTIVITY_KIND_TRASH', 'DISK_ACTIVITY_KIND_RENAME', 'DISK_ACTIVITY_KIND_CREATE']);
    const settings = await api(anna, `${W}/settings`, { method: 'PUT', body: { trashDays: 30 } });
    expect(((await settings.json()) as { trashDays: number }).trashDays).toBe(30);
  });
});

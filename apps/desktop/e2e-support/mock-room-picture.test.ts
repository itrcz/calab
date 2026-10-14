import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDS, startMockServer, type MockServer } from './mock-server';

// The room picture in the mock (ADR-0092): pnpm -F @calaba/desktop exec vitest run --config e2e-support/vitest.config.ts

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer({ scenario: 'data' });
});
afterAll(async () => {
  await server.close();
});

async function login(email = 'owner@calaba.test'): Promise<string> {
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

type MessageJson = { authorId: string; system?: { roomIcon?: { fileId?: string } } };

describe('room picture (ADR-0092)', () => {
  it('setRoomPicture → the room and a system line; PATCH "" removes it; a document is refused', async () => {
    const anna = await login();
    const room = IDS.rooms.dev;
    server.setRoomPicture(room, { bg: [40, 90, 200], fg: [255, 255, 255] }, IDS.users.anna);
    const got = (await (await api(anna, `/api/rooms/${room}`)).json()) as { room: { iconFileId?: string } };
    expect(got.room.iconFileId).toBeTruthy();
    expect((await api(anna, `/api/files/${got.room.iconFileId}/thumbnail`)).status).toBe(200);

    expect((await api(anna, `/api/rooms/${room}`, { method: 'PATCH', body: { iconFileId: IDS.files.pdf } })).status).toBe(422);
    const cleared = (await (await api(anna, `/api/rooms/${room}`, { method: 'PATCH', body: { iconFileId: '' } })).json()) as { room: { iconFileId?: string } };
    expect(cleared.room.iconFileId ?? '').toBe('');

    const list = (await (await api(anna, `/api/rooms/${room}/messages`)).json()) as { messages: MessageJson[] };
    const lines = list.messages.filter((m) => m.system?.roomIcon);
    expect(lines).toHaveLength(2);
    expect(lines.every((m) => m.authorId === IDS.users.anna)).toBe(true);
    expect(lines.filter((m) => !m.system?.roomIcon?.fileId)).toHaveLength(1);
  });
});

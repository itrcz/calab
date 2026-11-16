import { create } from '@bufbuild/protobuf';
import { FileMetaSchema, MessageSchema, UnfurlResponseSchema, type Message, type UnfurlResponse } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMessage = vi.fn<(roomId: string, body: { nonce: string; content: string }) => Promise<{ message?: Message }>>();
const listPins = vi.fn<(roomId: string) => Promise<{ messages: Message[] }>>();
const unfurlGet = vi.fn<(url: string) => Promise<UnfurlResponse>>();
vi.mock('../lib/api/endpoints', () => ({
  api: {
    messages: { create: (roomId: string, body: { nonce: string; content: string }) => createMessage(roomId, body), pins: (roomId: string) => listPins(roomId) },
    unfurl: { get: (url: string) => unfurlGet(url) },
  },
  uploadFile: vi.fn(),
  uploadPath: (ws: string, room: string) => (ws ? `/api/workspaces/${ws}/files` : `/api/dms/${room}/files`),
}));
vi.mock('./gateway', () => ({ sendTyping: () => undefined }));
vi.mock('../stores/toasts', () => ({ toast: { fail: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { sendMessage, retrySend, loadPins, resyncPins, unfurl, unfurlRetryMs, peekUnfurl, resetChatCaches } = await import('./chat');
const { ApiError } = await import('../lib/api/client');
const { useMessages } = await import('../stores/messages');
const { useSession } = await import('../stores/session');
const { uploadFile } = await import('../lib/api/endpoints');

const ROOM = 'room-1';
const server = (nonce: string, id = '0190a0b0-0000-7000-8000-000000000001'): Message =>
  create(MessageSchema, { id, roomId: ROOM, authorId: 'me', content: 'hi', nonce });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const items = () => useMessages.getState().rooms[ROOM]?.items ?? [];

beforeEach(() => {
  useMessages.getState().reset();
  useMessages.getState().setWindow(ROOM, [], false, false); // the room is open (loaded)
  createMessage.mockReset();
});

describe('chat.sendMessage', () => {
  it('POST response first (✓ — the server has it), then the gateway echo: one message', async () => {
    createMessage.mockImplementation((_r, b) => Promise.resolve({ message: server(b.nonce) }));
    await sendMessage('ws', ROOM, 'hi', [], undefined, 'n1');
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ status: 'sent' });
    useMessages.getState().upsert(server('n1')); // echo
    expect(items()).toHaveLength(1);
    expect(items()[0]?.status).toBe('sent');
  });

  it('echo before the POST response: one sent message', async () => {
    const d = deferred<{ message?: Message }>();
    createMessage.mockImplementation(() => d.promise);
    const p = sendMessage('ws', ROOM, 'hi', [], undefined, 'n2');
    await Promise.resolve();
    expect(items()[0]?.status).toBe('pending');
    useMessages.getState().upsert(server('n2')); // echo overtakes the response
    d.resolve({ message: server('n2') });
    await p;
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ status: 'sent' });
  });

  it('failed POST, then the echo arrives (server did store it): the failed copy is replaced', async () => {
    createMessage.mockImplementation(() => Promise.reject(new Error('timeout')));
    await sendMessage('ws', ROOM, 'hi', [], undefined, 'n3');
    expect(items()[0]?.status).toBe('failed');
    useMessages.getState().upsert(server('n3'));
    expect(items()).toHaveLength(1);
    expect(items()[0]?.status).toBe('sent');
  });

  it('retry keeps the nonce (the server deduplicates)', async () => {
    createMessage.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await sendMessage('ws', ROOM, 'hi', [], undefined, 'n4');
    const failed = items()[0];
    expect(failed?.status).toBe('failed');
    createMessage.mockImplementation((_r, b) => Promise.resolve({ message: server(b.nonce) }));
    if (failed) await retrySend('ws', ROOM, failed);
    expect(createMessage.mock.calls.map((c) => c[1].nonce)).toEqual(['n4', 'n4']);
    expect(items()).toHaveLength(1);
    expect(items()[0]?.status).toBe('sent');
  });
});

describe('chat.sendMessage — attachments too large (CBF-191)', () => {
  const blob = (size: number) => new Blob([new Uint8Array(size)], { type: 'application/octet-stream' });
  const upload = vi.mocked(uploadFile);
  beforeEach(() => {
    upload.mockReset();
    useSession.getState().set({ maxFileMb: 0 });
  });

  it('a file above the known limit fails before uploading, without «Повторить»', async () => {
    useSession.getState().set({ maxFileMb: 1 }); // a DM: the server's limit
    await sendMessage('', ROOM, '', [{ file: blob(2 << 20), name: 'big.bin' }], undefined, 'n5');
    expect(upload).not.toHaveBeenCalled();
    expect(items()[0]).toMatchObject({ status: 'failed', final: true, error: 'Файл слишком большой, лимит 1 МБ' });
  });

  it('a proxy 413 page names the size, not «Сервер недоступен», and is final', async () => {
    upload.mockReturnValue({ promise: Promise.reject(new ApiError('ERROR_CODE_UNSPECIFIED', 'Request Entity Too Large', 413)), abort: () => undefined });
    await sendMessage('', ROOM, '', [{ file: blob(10), name: 'a.bin' }], undefined, 'n6');
    expect(items()[0]).toMatchObject({ status: 'failed', final: true, error: 'Файл слишком большой' });
  });

  it('«Повторить» after a network failure uploads the same files again', async () => {
    const meta = create(FileMetaSchema, { id: 'f1', name: 'a.bin' });
    upload.mockReturnValueOnce({ promise: Promise.reject(new ApiError('ERROR_CODE_UNAVAILABLE', 'upload failed', 0)), abort: () => undefined });
    const file = { file: blob(10), name: 'a.bin' };
    await sendMessage('', ROOM, '', [file], undefined, 'n7');
    const failed = items()[0];
    expect(failed).toMatchObject({ status: 'failed', final: false });
    upload.mockReturnValueOnce({ promise: Promise.resolve(meta), abort: () => undefined });
    createMessage.mockImplementation((_r, b) => Promise.resolve({ message: server(b.nonce) }));
    if (failed) await retrySend('', ROOM, failed);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]?.[1]).toBe(file.file);
    expect(items()[0]?.status).toBe('sent');
  });
});

describe('chat.loadPins (docs/18 step 4)', () => {
  const pinned = (id: string): Message => create(MessageSchema, { id, roomId: ROOM, authorId: 'me', content: 'pin', pinnedAt: { seconds: 1n } });

  beforeEach(() => {
    listPins.mockReset();
    listPins.mockImplementation(() => Promise.resolve({ messages: [pinned('p1')] }));
  });

  it('fetches once per room; reopening uses the live-updated store', async () => {
    await loadPins(ROOM);
    await loadPins(ROOM);
    expect(listPins).toHaveBeenCalledTimes(1);
    useMessages.getState().upsert(pinned('p2')); // a pin event while the room is closed
    expect(useMessages.getState().pins[ROOM]?.map((m) => m.id)).toEqual(['p2', 'p1']);
    await loadPins(ROOM);
    expect(listPins).toHaveBeenCalledTimes(1);
  });

  it('refetches after the store dropped them (unload) and on resync', async () => {
    await loadPins(ROOM);
    useMessages.getState().unload(ROOM);
    await loadPins(ROOM);
    expect(listPins).toHaveBeenCalledTimes(2);
    listPins.mockImplementation(() => Promise.resolve({ messages: [] }));
    await resyncPins();
    expect(listPins).toHaveBeenCalledTimes(3);
    expect(useMessages.getState().pins[ROOM]).toEqual([]);
  });

  it('a failed fetch is retried on the next open', async () => {
    listPins.mockImplementationOnce(() => Promise.reject(new Error('net')));
    await loadPins(ROOM);
    await loadPins(ROOM);
    expect(listPins).toHaveBeenCalledTimes(2);
  });
});

// Issue #220: «preview not found» (404) is the server's normal answer for a link without a card.
describe('chat.unfurl', () => {
  it('a 404 is «no preview»: resolves null, never rejects, and is not fetched again', async () => {
    unfurlGet.mockReset();
    unfurlGet.mockRejectedValue(new ApiError('ERROR_CODE_NOT_FOUND', 'preview not found', 404));
    const url = 'https://example.test/no-card';
    await expect(unfurl(url)).resolves.toBeNull();
    await expect(unfurl(url)).resolves.toBeNull(); // a remounted row (Virtuoso) asks again
    expect(unfurlGet).toHaveBeenCalledTimes(1);
  });

  it('a card without anything to show is null too; a real card is returned', async () => {
    unfurlGet.mockReset();
    unfurlGet.mockImplementation((u) => Promise.resolve(create(UnfurlResponseSchema, u.endsWith('/empty') ? { url: u } : { url: u, title: 'Title' })));
    await expect(unfurl('https://example.test/empty')).resolves.toBeNull();
    await expect(unfurl('https://example.test/card')).resolves.toMatchObject({ title: 'Title' });
  });

  // GitHub #313: a row the feed remounts draws its preview at the final height on the first render.
  it('peekUnfurl: the answer synchronously once it is in (a card or null), nothing before or after a reset', async () => {
    unfurlGet.mockReset();
    let answer: (r: UnfurlResponse) => void = () => undefined;
    unfurlGet.mockImplementation((u) => (u.endsWith('/slow') ? new Promise((res) => (answer = res)) : Promise.reject(new ApiError('ERROR_CODE_NOT_FOUND', 'preview not found', 404))));
    const slow = 'https://example.test/peek/slow';
    const missing = 'https://example.test/peek/missing';
    expect(peekUnfurl(slow)).toBeUndefined();
    const p = unfurl(slow);
    expect(peekUnfurl(slow)).toBeUndefined(); // on its way
    answer(create(UnfurlResponseSchema, { url: slow, title: 'Slow card' }));
    await p;
    expect(peekUnfurl(slow)).toMatchObject({ title: 'Slow card' });
    await unfurl(missing);
    expect(peekUnfurl(missing)).toBeNull(); // «preview not found» is an answer too: no card, no growth later
    resetChatCaches();
    expect(peekUnfurl(slow)).toBeUndefined();
    expect(peekUnfurl(missing)).toBeUndefined();
  });

  // CBF-176: a bot's fresh link gets a 429 / 503 for a moment; that used to stay «no preview» for the session.
  it('a transient failure (429 / 5xx / network) is retried, then forgotten: never a session-long «no preview»', async () => {
    const saved = unfurlRetryMs.delays;
    unfurlRetryMs.delays = [1, 1];
    try {
      unfurlGet.mockReset();
      const url = 'https://example.test/flaky';
      unfurlGet
        .mockRejectedValueOnce(new ApiError('ERROR_CODE_RATE_LIMITED', 'slow down', 429))
        .mockRejectedValueOnce(new TypeError('network'))
        .mockResolvedValueOnce(create(UnfurlResponseSchema, { url, title: 'Late card' }));
      await expect(unfurl(url)).resolves.toMatchObject({ title: 'Late card' });
      expect(unfurlGet).toHaveBeenCalledTimes(3);
      expect(peekUnfurl(url)).toMatchObject({ title: 'Late card' });

      const down = 'https://example.test/down';
      unfurlGet.mockReset();
      unfurlGet.mockRejectedValue(new ApiError('ERROR_CODE_INTERNAL', 'boom', 503));
      await expect(unfurl(down)).resolves.toBeNull();
      expect(unfurlGet).toHaveBeenCalledTimes(3);
      expect(peekUnfurl(down)).toBeUndefined(); // not an answer: the next mount asks again
      unfurlGet.mockReset();
      unfurlGet.mockResolvedValue(create(UnfurlResponseSchema, { url: down, title: 'Back' }));
      await expect(unfurl(down)).resolves.toMatchObject({ title: 'Back' });
    } finally {
      unfurlRetryMs.delays = saved;
    }
  });
});

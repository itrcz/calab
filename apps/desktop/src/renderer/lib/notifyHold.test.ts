import { describe, expect, it, vi } from 'vitest';

const env = vi.hoisted((): { kind: string } => ({ kind: 'electron' }));
vi.mock('../platform', () => ({
  platform: {
    get kind() {
      return env.kind;
    },
  },
}));

const { WORKER_CLICK, handleWorkerMessage, heldNotificationCount, holdNotification, showNotification, workerNotificationCount } = await import('./notifyHold');
type WorkerRegistration = import('./notifyHold').WorkerRegistration;

describe('holdNotification', () => {
  it('holds until click, close or error', () => {
    const base = heldNotificationCount();
    const a = holdNotification(new EventTarget());
    const b = holdNotification(new EventTarget());
    const c = holdNotification(new EventTarget());
    expect(heldNotificationCount()).toBe(base + 3);
    a.dispatchEvent(new Event('click'));
    b.dispatchEvent(new Event('close'));
    c.dispatchEvent(new Event('error'));
    expect(heldNotificationCount()).toBe(base);
  });
});

/** A fake system notification: its options and whether it was closed. */
class Fake extends EventTarget {
  closed = false;
  onclick: (() => void) | null = null;
  constructor(readonly options: NotificationOptions) {
    super();
  }
  close(): void {
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
}

describe('showNotification: replacement by tag', () => {
  const shown: Fake[] = [];
  const create = (_t: string, o: NotificationOptions): Fake => {
    const f = new Fake(o);
    shown.push(f);
    return f;
  };

  it('desktop: the tag never reaches Electron, the previous one of the tag is closed by us', () => {
    env.kind = 'electron';
    shown.length = 0;
    const base = heldNotificationCount();
    showNotification('a', { tag: 'dm:1', body: 'x' }, { create });
    showNotification('b', { tag: 'dm:1' }, { create });
    showNotification('c', { tag: 'dm:2' }, { create });
    expect(shown.map((f) => f.options.tag)).toEqual([undefined, undefined, undefined]);
    expect(shown[0]?.options.body).toBe('x');
    expect(shown.map((f) => f.closed)).toEqual([true, false, false]);
    // The newest of each tag stays held (its click handler alive); the replaced one is released.
    expect(heldNotificationCount()).toBe(base + 2);
  });

  it('desktop: a clicked notification is forgotten, the next one of its tag closes nothing', () => {
    env.kind = 'electron';
    shown.length = 0;
    showNotification('a', { tag: 'task:1' }, { create });
    shown[0]?.dispatchEvent(new Event('click'));
    showNotification('b', { tag: 'task:1' }, { create });
    expect(shown[0]?.closed).toBe(false);
  });

  it('web without a service worker: the constructor, the native tag stays (Chrome replaces correctly, tabs share it)', async () => {
    env.kind = 'web';
    shown.length = 0;
    const none = (): Promise<undefined> => Promise.resolve(undefined);
    const a = showNotification('a', { tag: 'room' }, { create, registration: none });
    const b = showNotification('b', { tag: 'room' }, { create, registration: none });
    await Promise.all([a.shown, b.shown]);
    expect(shown.map((f) => f.options.tag)).toEqual(['room', 'room']);
    expect(shown[0]?.closed).toBe(false);
    const click = vi.fn();
    b.onclick = click;
    shown[1]?.onclick?.();
    expect(click).toHaveBeenCalledTimes(1);
    b.close();
    expect(shown[1]?.closed).toBe(true);
  });
});

/** A fake `ServiceWorkerRegistration`: what it shows, closable by data like the real one. */
function fakeRegistration(): WorkerRegistration & { list: Array<{ title: string; options: NotificationOptions; closed: boolean; data?: unknown; close(): void }> } {
  const list: Array<{ title: string; options: NotificationOptions; closed: boolean; data?: unknown; close(): void }> = [];
  return {
    list,
    showNotification(title, options = {}) {
      // The native tag: the previous one of the tag disappears.
      for (const n of list) if (options.tag && n.options.tag === options.tag) n.closed = true;
      const n = { title, options, closed: false, data: options.data as unknown, close: () => void (n.closed = true) };
      list.push(n);
      return Promise.resolve();
    },
    getNotifications(filter) {
      return Promise.resolve(list.filter((n) => !n.closed && (!filter?.tag || n.options.tag === filter.tag)));
    },
  };
}

describe('showNotification: web through the service worker', () => {
  const create = vi.fn(() => {
    throw new TypeError('Illegal constructor'); // Chrome on Android
  });

  it('shows via the registration with the tag and an id; the worker click runs onclick once', async () => {
    env.kind = 'web';
    const reg = fakeRegistration();
    const base = workerNotificationCount();
    const n = showNotification('#общий · Борис', { body: 'hi', tag: 'room:1', silent: true }, { create, registration: () => Promise.resolve(reg) });
    const click = vi.fn();
    n.onclick = click;
    await n.shown;
    expect(create).not.toHaveBeenCalled();
    expect(reg.list).toHaveLength(1);
    expect(reg.list[0]?.options).toMatchObject({ body: 'hi', tag: 'room:1', silent: true });
    const id = (reg.list[0]?.data as { calabId: string }).calabId;
    expect(typeof id).toBe('string');
    expect(workerNotificationCount()).toBe(base + 1);
    expect(handleWorkerMessage({ type: 'other', id })).toBe(false);
    expect(handleWorkerMessage({ type: WORKER_CLICK, id: 'another-tab' })).toBe(false);
    expect(handleWorkerMessage({ type: WORKER_CLICK, id })).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(handleWorkerMessage({ type: WORKER_CLICK, id })).toBe(false);
    expect(workerNotificationCount()).toBe(base);
  });

  it('close() closes only its own notification of the tag; a replaced one is forgotten', async () => {
    env.kind = 'web';
    const reg = fakeRegistration();
    const registration = (): Promise<WorkerRegistration> => Promise.resolve(reg);
    const base = workerNotificationCount();
    const a = showNotification('a', { tag: 'call:1' }, { create, registration });
    await a.shown;
    const b = showNotification('b', { tag: 'call:1' }, { create, registration });
    await b.shown;
    expect(workerNotificationCount()).toBe(base + 1); // a was replaced by the system
    a.close(); // already gone: must not close b
    await Promise.resolve();
    await Promise.resolve();
    expect(reg.list[1]?.closed).toBe(false);
    b.close();
    await vi.waitFor(() => expect(reg.list[1]?.closed).toBe(true));
    expect(workerNotificationCount()).toBe(base);
  });

  it('closed before the registration answered: nothing is shown', async () => {
    env.kind = 'web';
    const reg = fakeRegistration();
    const n = showNotification('a', { tag: 't' }, { create, registration: () => Promise.resolve(reg) });
    n.close();
    await n.shown;
    expect(reg.list).toHaveLength(0);
  });

  it('the registration fails and the constructor throws: `shown` rejects (the settings test says «failed»)', async () => {
    env.kind = 'web';
    const broken: WorkerRegistration = {
      showNotification: () => Promise.reject(new TypeError('No active registration')),
      getNotifications: () => Promise.resolve([]),
    };
    const n = showNotification('a', {}, { create, registration: () => Promise.resolve(broken) });
    await expect(n.shown).rejects.toThrow('Illegal constructor');
    const m = showNotification('a', {}, { create, registration: () => Promise.resolve(undefined) });
    await expect(m.shown).rejects.toThrow('Illegal constructor');
  });
});

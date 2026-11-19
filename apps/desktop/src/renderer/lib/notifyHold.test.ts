import { describe, expect, it, vi } from 'vitest';

const env = vi.hoisted((): { kind: string } => ({ kind: 'electron' }));
vi.mock('../platform', () => ({
  platform: {
    get kind() {
      return env.kind;
    },
  },
}));

const { heldNotificationCount, holdNotification, showNotification } = await import('./notifyHold');

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
    showNotification('a', { tag: 'dm:1', body: 'x' }, create);
    showNotification('b', { tag: 'dm:1' }, create);
    showNotification('c', { tag: 'dm:2' }, create);
    expect(shown.map((f) => f.options.tag)).toEqual([undefined, undefined, undefined]);
    expect(shown[0]?.options.body).toBe('x');
    expect(shown.map((f) => f.closed)).toEqual([true, false, false]);
    // The newest of each tag stays held (its click handler alive); the replaced one is released.
    expect(heldNotificationCount()).toBe(base + 2);
  });

  it('desktop: a clicked notification is forgotten, the next one of its tag closes nothing', () => {
    env.kind = 'electron';
    shown.length = 0;
    showNotification('a', { tag: 'task:1' }, create);
    shown[0]?.dispatchEvent(new Event('click'));
    showNotification('b', { tag: 'task:1' }, create);
    expect(shown[0]?.closed).toBe(false);
  });

  it('web: the native tag stays (Chrome replaces correctly, tabs share it)', () => {
    env.kind = 'web';
    shown.length = 0;
    showNotification('a', { tag: 'room' }, create);
    showNotification('b', { tag: 'room' }, create);
    expect(shown.map((f) => f.options.tag)).toEqual(['room', 'room']);
    expect(shown[0]?.closed).toBe(false);
  });
});

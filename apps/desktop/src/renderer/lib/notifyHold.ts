import { platform } from '../platform';

/**
 * Keeps a system notification reachable until it is clicked or closed. A `Notification` nobody
 * references is garbage-collected, and with it its `onclick`: on Windows the toast then only
 * activates the window (no navigation, or the app stays on whatever was open before). Returns the
 * notification for chaining. Pure bookkeeping over the object's own events (tests).
 */
const held = new Set<object>();

interface Releasable {
  addEventListener(type: 'click' | 'close' | 'error', fn: () => void): void;
}

export function holdNotification<T extends Releasable>(n: T): T {
  held.add(n);
  const release = (): void => void held.delete(n);
  n.addEventListener('click', release);
  n.addEventListener('close', release);
  n.addEventListener('error', release);
  return n;
}

/** Notifications currently kept alive (tests). */
export function heldNotificationCount(): number {
  return held.size;
}

interface Shown extends Releasable {
  close(): void;
}

/** What callers of `showNotification` use: the click handler and closing it. */
export interface AppNotification {
  onclick: ((this: unknown, ev: Event) => unknown) | null;
  close(): void;
  /** Web: settles once shown, rejects when no path could show it (the settings «Показать» test). */
  readonly shown?: Promise<void>;
}

/** The part of `ServiceWorkerRegistration` the web path uses (injectable for tests). */
export interface WorkerRegistration {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
  getNotifications(filter?: { tag?: string }): Promise<ReadonlyArray<{ data?: unknown; close(): void }>>;
}

export interface NotifyDeps {
  create: (title: string, options: NotificationOptions) => Shown;
  /** The active service worker registration of the web origin, or undefined (dev, unsupported). */
  registration: () => Promise<WorkerRegistration | undefined>;
}

/** The message sw.js posts to the page on `notificationclick` (vite.web.config.ts). */
export const WORKER_CLICK = 'calab:notification-click';

/** The newest notification per tag in the desktop app (the replacement done here, see below). */
const byTag = new Map<string, Shown>();

/**
 * Shows a held system notification. `tag` means «replaces the previous one of the same source».
 *
 * Electron (desktop, all OSes) cannot be given the tag: Chromium derives the notification id from
 * it, registers the new page listener under that id, and only then Electron closes the old
 * notification of the same id — its close event reaches the NEW listener, which is dropped. The
 * new notification stays on screen, but its click finds no listener: macOS only activates the app
 * (the window comes up on whatever was open), nothing navigates. Every second message of a DM /
 * room, every second update of a task hit it. So on desktop the replacement is ours: the previous
 * notification of the tag is closed and the new one has a unique id.
 *
 * The web keeps the native tag (Chrome replaces correctly, and tabs share it) and shows through the
 * service worker (`registration.showNotification`): Chrome on Android has no `new Notification()`
 * (TypeError «Illegal constructor»). sw.js relays the click back as a message and the page runs the
 * same `onclick` as before; without an active worker (dev build, no SW support) — the constructor.
 * `deps` are injectable for tests.
 */
export function showNotification(title: string, options: NotificationOptions = {}, deps: Partial<NotifyDeps> = {}): AppNotification {
  const create = deps.create ?? ((t, o) => new Notification(t, o));
  if (platform.kind === 'web') return new WebNotification(title, options, create, deps.registration ?? activeRegistration);
  const { tag, ...rest } = options;
  if (!tag) return holdNotification(create(title, options)) as unknown as AppNotification;
  byTag.get(tag)?.close();
  const n = holdNotification(create(title, rest));
  byTag.set(tag, n);
  const forget = (): void => {
    if (byTag.get(tag) === n) byTag.delete(tag);
  };
  n.addEventListener('click', forget);
  n.addEventListener('close', forget);
  n.addEventListener('error', forget);
  return n as unknown as AppNotification;
}

/** Web notifications shown through the worker, by id, until clicked, closed or replaced. */
const viaWorker = new Map<string, WebNotification>();
/** Unclicked notifications nobody closes (the user swiped them away) must not pile up. */
const MAX_TRACKED = 50;

let seq = 0;

class WebNotification implements AppNotification {
  onclick: AppNotification['onclick'] = null;
  readonly shown: Promise<void>;
  readonly id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  private closed = false;
  private worker: WorkerRegistration | undefined;
  private native: Shown | undefined;

  constructor(title: string, private readonly options: NotificationOptions, create: NotifyDeps['create'], registration: NotifyDeps['registration']) {
    this.shown = this.show(title, create, registration);
    this.shown.catch(() => undefined); // callers that do not await it: no unhandled rejection
  }

  get tag(): string | undefined {
    return this.options.tag || undefined;
  }

  /** `close()` may run while `show` awaits (a method, so the check is not narrowed away). */
  private isClosed(): boolean {
    return this.closed;
  }

  private async show(title: string, create: NotifyDeps['create'], registration: NotifyDeps['registration']): Promise<void> {
    const reg = await registration().catch(() => undefined);
    if (this.isClosed()) return;
    if (reg) {
      try {
        track(this);
        await reg.showNotification(title, { ...this.options, data: { calabId: this.id, href: typeof location === 'undefined' ? undefined : location.href } });
        this.worker = reg;
        if (this.isClosed()) this.closeShown();
        return;
      } catch {
        viaWorker.delete(this.id); // the constructor below; the worker never answers for it
      }
    }
    const n = holdNotification(create(title, this.options));
    n.addEventListener('click', () => this.click());
    this.native = n;
    if (this.isClosed()) n.close();
  }

  click(): void {
    viaWorker.delete(this.id);
    this.onclick?.call(this, new Event('click'));
  }

  /** Replaced by a newer notification of the same tag: the system already dropped it. */
  replaced(): void {
    viaWorker.delete(this.id);
  }

  close(): void {
    this.closed = true;
    viaWorker.delete(this.id);
    this.closeShown();
  }

  private closeShown(): void {
    this.native?.close();
    const reg = this.worker;
    if (!reg) return;
    const tag = this.tag;
    void reg
      .getNotifications(tag ? { tag } : undefined)
      .then((list) => {
        for (const n of list) if ((n.data as { calabId?: unknown } | undefined)?.calabId === this.id) n.close();
      })
      .catch(() => undefined);
  }
}

function track(n: WebNotification): void {
  const tag = n.tag;
  if (tag) for (const other of [...viaWorker.values()]) if (other.tag === tag) other.replaced();
  viaWorker.set(n.id, n);
  while (viaWorker.size > MAX_TRACKED) {
    const oldest = viaWorker.keys().next().value;
    if (oldest === undefined) break;
    viaWorker.delete(oldest);
  }
}

/** A message from sw.js: the click of a notification this page showed runs its handler. */
export function handleWorkerMessage(data: unknown): boolean {
  const msg = data as { type?: unknown; id?: unknown } | null;
  if (!msg || msg.type !== WORKER_CLICK || typeof msg.id !== 'string') return false;
  const n = viaWorker.get(msg.id);
  if (!n) return false; // another tab's notification (sw.js tells every tab)
  n.click();
  return true;
}

/** Web notifications awaiting a click from the worker (tests). */
export function workerNotificationCount(): number {
  return viaWorker.size;
}

const READY_TIMEOUT_MS = 3000;
let listening = false;

/**
 * The service worker registration of the page, once active (sw.js is registered after load, see
 * lib/mobile.ts registerServiceWorker; on the first visit it may still be installing — waited for
 * a moment). Also starts listening for the worker's click messages.
 */
async function activeRegistration(): Promise<WorkerRegistration | undefined> {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw) return undefined;
  if (!listening) {
    listening = true;
    sw.addEventListener('message', (e) => void handleWorkerMessage(e.data));
    sw.startMessages();
  }
  const reg = await sw.getRegistration();
  if (!reg) return undefined;
  if (reg.active) return reg;
  return Promise.race([sw.ready, new Promise<undefined>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS))]);
}

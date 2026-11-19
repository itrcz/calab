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
 * notification of the tag is closed and the new one has a unique id. The web keeps the native tag
 * (Chrome replaces correctly, and tabs share it). `create` is injectable for tests.
 */
export function showNotification(
  title: string,
  options: NotificationOptions = {},
  create: (title: string, options: NotificationOptions) => Shown = (t, o) => new Notification(t, o),
): Notification {
  const { tag, ...rest } = options;
  if (!tag || platform.kind === 'web') return holdNotification(create(title, options)) as Notification;
  byTag.get(tag)?.close();
  const n = holdNotification(create(title, rest));
  byTag.set(tag, n);
  const forget = (): void => {
    if (byTag.get(tag) === n) byTag.delete(tag);
  };
  n.addEventListener('click', forget);
  n.addEventListener('close', forget);
  n.addEventListener('error', forget);
  return n as Notification;
}

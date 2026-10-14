import type { HostNotificationsCapability } from '../../shared/hostActivity';

/**
 * Notification permission for the onboarding step (docs/09 #20): one pure mapping from the
 * browser / Electron state to what the step shows, so `default` («not asked yet») is never
 * presented as «denied».
 */
export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

type NotificationApi = { permission?: string; requestPermission?: (cb?: (p: string) => void) => Promise<string> | undefined } | undefined;

function normalise(p: unknown): NotifyState {
  return p === 'granted' || p === 'denied' || p === 'default' ? p : 'default';
}

/** Current state; `unsupported` without the API (insecure context, iOS Safari outside a PWA). */
export function readNotifyState(api: NotificationApi = (globalThis as { Notification?: NotificationApi }).Notification, host?: HostNotificationsCapability): NotifyState {
  if (host) return 'default';
  if (!api || typeof api.requestPermission !== 'function') return 'unsupported';
  return normalise(api.permission);
}

/**
 * Asks the browser — call it straight from the click handler (user gesture). Handles the old
 * callback-only Safari API and never throws: a failure leaves the state as it was.
 */
export function requestNotify(api: NotificationApi = (globalThis as { Notification?: NotificationApi }).Notification, host?: HostNotificationsCapability): Promise<NotifyState> {
  if (host) return host.state(true).then(s => s.permission === 'unsupported' ? 'unsupported' : s.permission);
  if (!api || typeof api.requestPermission !== 'function') return Promise.resolve('unsupported');
  const request = api.requestPermission.bind(api);
  return new Promise<NotifyState>((resolve) => {
    try {
      const r = request((p) => resolve(normalise(p)));
      if (r && typeof r.then === 'function') r.then((p) => resolve(normalise(p)), () => resolve(readNotifyState(api)));
    } catch {
      resolve(readNotifyState(api));
    }
  });
}

export interface NotifyStepView {
  /** Status line under the sample: green «включены», yellow «запрещены», muted «не поддерживает». */
  note: 'granted' | 'denied' | 'unsupported' | null;
  /** Primary action: ask (only while not asked), or go on. */
  primary: 'enable' | 'continue' | 'continue-without';
  /** «Позже» next to «Включить уведомления». */
  later: boolean;
}

export function notifyStepView(state: NotifyState): NotifyStepView {
  switch (state) {
    case 'default':
      return { note: null, primary: 'enable', later: true };
    case 'granted':
      return { note: 'granted', primary: 'continue', later: false };
    case 'denied':
      return { note: 'denied', primary: 'continue-without', later: false };
    case 'unsupported':
      return { note: 'unsupported', primary: 'continue', later: false };
  }
}

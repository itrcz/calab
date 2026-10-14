import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { CloseButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import type { DeviceSwitch } from '../../lib/deviceSwitch';
import { useMobile } from '../../lib/mobile';
import { toastPlacement, type ToastPlacement } from '../../lib/toastPlacement';
import { announceDeviceSwitch } from '../../services/deviceToast';
import { useSession } from '../../stores/session';
import { isSticky, stackInteraction, type Toast, type ToastAction } from '../../stores/toastQueue';
import { TOAST_MS, useToasts } from '../../stores/toasts';

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST / ?visual-test): raise a toast without a real failure. */
    __calabaToast?: (kind: Toast['kind'], text: string, action?: ToastAction) => void;
    /** Visual tests only: the «the OS switched the audio device» toast (docs/09 #49) without a real device change. */
    __calabaDeviceToast?: (kind: DeviceSwitch['kind'], label: string) => void;
  }
}

/**
 * Where the stack goes (lib/toastPlacement.ts): bottom-centre of the chat column
 * (`[data-toast-anchor]`, ChatPane), 16 px above its composer; follows the column's size and the
 * composer's height (--composer-height on the column's parent). Phones: null (CSS classes).
 */
function useToastPlacement(active: boolean): ToastPlacement | null {
  const mobile = useMobile();
  const [placement, setPlacement] = useState<ToastPlacement | null>(null);
  useLayoutEffect(() => {
    if (mobile || !active) return;
    const measure = (): void => {
      const anchor = document.querySelector<HTMLElement>('[data-toast-anchor]');
      const composer = anchor ? parseFloat(getComputedStyle(anchor).getPropertyValue('--composer-height')) || 0 : 0;
      setPlacement(
        toastPlacement({
          mobile: false,
          anchor: anchor?.getBoundingClientRect() ?? null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          composer,
        }),
      );
    };
    measure();
    const anchor = document.querySelector<HTMLElement>('[data-toast-anchor]');
    const ro = new ResizeObserver(measure);
    const mo = new MutationObserver(measure);
    if (anchor) {
      ro.observe(anchor);
      // --composer-height is written to the column's parent style; a room switch replaces the column.
      if (anchor.parentElement) mo.observe(anchor.parentElement, { attributes: true, attributeFilter: ['style'], childList: true });
    }
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [mobile, active]);
  return mobile ? null : placement;
}

/**
 * Toast stack (docs/09 #16, docs/08 «Тосты»): opaque mat-popover, bottom-centre of the chat
 * column 16 px above the composer, ≤ 480 px wide, growing upwards, newest at
 * the bottom. Each toast hides after TOAST_MS; the countdown pauses while the pointer or
 * keyboard focus is in the stack and while the window is hidden (a toast raised in the
 * background waits to be seen). Errors are announced assertively (role="alert"), the rest
 * politely. Esc on a focused toast closes it.
 */
export function Toasts(): ReactNode {
  const items = useToasts((s) => s.items);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const stack = useRef<HTMLElement>(null);
  const [{ hover, focus }, interact] = useReducer(stackInteraction, { hover: false, focus: false });
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);

  useEffect(() => {
    const on = (): void => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    if (!visualTest) return;
    window.__calabaToast = (kind, text, action) => void useToasts.getState().push(kind, text, action);
    window.__calabaDeviceToast = (kind, label) => announceDeviceSwitch({ kind, label });
    return () => {
      delete window.__calabaToast;
      delete window.__calabaDeviceToast;
    };
  }, [visualTest]);

  useLayoutEffect(() => {
    // Removing the toast under the pointer or focus (dismiss, dedupe or queue eviction) emits
    // no pointerleave/blur: reconcile with the surviving DOM so the stack cannot stay paused
    // indefinitely (#45). A pointer that is still over the stack re-arms hover on its next move.
    interact({ type: 'items', focusInside: stack.current?.contains(document.activeElement) ?? false });
  }, [items]);

  const paused = hover || focus || hidden || visualTest;
  const place = useToastPlacement(items.length > 0);
  return (
    <section
      ref={stack}
      aria-label={t('toast.region')}
      // A web app's native view steps aside while the stack shows (features/webapps/AppScreen).
      data-app-occluder
      // Phones: under the top bar (at the bottom it would cover the composer and the voice strip),
      // and under the drawers and sheets, which the user is working in.
      className="pointer-events-none fixed z-[var(--z-toast)] flex flex-col items-stretch gap-2 mobile:left-4 mobile:right-4 mobile:top-[calc(var(--safe-top)+56px)] mobile:z-[var(--z-popover)]"
      style={place ? { left: place.centerX, bottom: place.bottom, width: place.width, transform: 'translateX(-50%)' } : undefined}
      onPointerEnter={() => interact({ type: 'enter' })}
      onPointerMove={() => interact({ type: 'enter' })}
      onPointerLeave={() => interact({ type: 'leave' })}
      onFocus={() => interact({ type: 'focus' })}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) interact({ type: 'blur' });
      }}
    >
      {items.map((x) => (
        <ToastItem key={x.id} toast={x} paused={paused} />
      ))}
    </section>
  );
}

const ICON = { error: CircleAlert, success: CircleCheck, info: Info } as const;

function ToastItem({ toast: x, paused }: { toast: Toast; paused: boolean }): ReactNode {
  const dismiss = useToasts((s) => s.dismiss);
  const left = useRef(x.durationMs ?? TOAST_MS);
  const sticky = isSticky(x);

  useEffect(() => {
    if (paused || sticky) return;
    const started = Date.now();
    const id = window.setTimeout(() => dismiss(x.id), left.current);
    return () => {
      window.clearTimeout(id);
      left.current = Math.max(1000, left.current - (Date.now() - started));
    };
  }, [paused, sticky, dismiss, x.id]);

  const Icon = ICON[x.kind];
  return (
    <div
      role={x.kind === 'error' ? 'alert' : 'status'}
      aria-live={x.kind === 'error' ? 'assertive' : 'polite'}
      data-testid="toast"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          dismiss(x.id);
        }
      }}
      className="mat-popover anim-in pointer-events-auto flex items-center gap-2.5 rounded-[20px] py-2.5 pl-4 pr-2.5 text-body text-fg"
    >
      <Icon className={cx('size-[18px] shrink-0', x.kind === 'error' ? 'text-danger' : x.kind === 'success' ? 'text-ok' : 'text-accent')} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <span className="selectable break-words [overflow-wrap:anywhere]">
          {x.text}
          {x.count && x.count > 1 ? <span className="ml-1.5 text-caption text-muted">×{x.count}</span> : null}
        </span>
        {x.action ? (
          <button
            type="button"
            className="-ml-1 rounded-[var(--radius-control)] px-1 text-body font-medium text-accent-text hover:underline"
            onClick={() => {
              dismiss(x.id);
              x.action?.run();
            }}
          >
            {x.action.label}
          </button>
        ) : null}
      </div>
      <CloseButton label={t('toast.close')} shortcut="" className="size-6" onClick={() => dismiss(x.id)} />
    </div>
  );
}

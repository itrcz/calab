import { ExternalLink } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { WebAppBounds } from '../../../shared/ipc';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { coversContent, visibleViewRect } from '../../lib/webApps';
import { platform } from '../../platform';
import { setAppViewRect } from '../../services/webAppTip';
import { openAppInBrowser } from '../../services/webApps';
import { useWebApps } from '../../stores/webApps';
import { useToasts } from '../../stores/toasts';
import { useCall } from '../../stores/call';
import { useAdmissions } from '../guests/stores/admissions';

/** The web app fills the content area down to the window bottom, also during calls. */
export function AppScreen({ appId }: { appId: string }): ReactNode {
  const url = useWebApps((s) => s.byId[appId]?.url ?? '');
  if (!url) return null;
  return (
    <div
      className="mat-content flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-panel)] border-l border-t border-line"
      data-testid="app-screen"
    >
      <LoadLine appId={appId} />
      {platform.webApps ? <DesktopView appId={appId} url={url} /> : <WebFrame appId={appId} url={url} />}
    </div>
  );
}

/**
 * The 2 px line above the site while it loads (the native view cannot be drawn over, so it is a
 * row of its own). Finite: one CSS animation to 85 % per load (mounted only while loading —
 * nothing runs at rest), gone when the page stops loading. Desktop only: the web frame has no state.
 */
const LoadLine = memo(function LoadLine({ appId }: { appId: string }): ReactNode {
  const loading = useWebApps((s) => s.nav[appId]?.loading ?? false);
  return (
    <div className="h-0.5 shrink-0" aria-hidden data-testid="app-load-line">
      {loading ? <div className="wapp-load h-full bg-accent" /> : null}
    </div>
  );
});

// ---------------------------------------------------------------- desktop: a main-process view

function rectOf(el: HTMLElement): WebAppBounds {
  const r = el.getBoundingClientRect();
  return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.max(0, r.width), height: Math.max(0, r.height) };
}

/**
 * True while a menu, popover or dialog of our page is open: the native view is drawn above the
 * whole page and would hide it, so the view steps aside meanwhile. Watches only <body>'s own
 * children (where Radix portals mount) — no work while nothing opens or closes.
 */
function overlayOpenNow(): boolean {
  return Array.from(document.body.children).some((c) => coversContent(c));
}

function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(overlayOpenNow);
  useEffect(() => {
    const mo = new MutationObserver(() => setOpen(overlayOpenNow()));
    mo.observe(document.body, { childList: true });
    return () => mo.disconnect();
  }, []);
  return open;
}

/** A hidden view (main: zero bounds take it out of the window, it stays alive). */
const HIDDEN: WebAppBounds = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Overlays the view steps aside for. Not tooltips: a tooltip over the app is drawn above it by a
 * native overlay (services/webAppTip.ts, ADR-0053 «Поправка 1») — the site no longer shrinks on hover.
 */
const OCCLUDERS = '[data-app-occluder]';

/** Where the view goes now (and what tooltips check against: services/webAppTip.ts). */
function viewRect(el: HTMLElement): WebAppBounds {
  const r = visibleViewRect(rectOf(el), occluderRects());
  setAppViewRect(r, platform.webApps);
  return r ?? HIDDEN;
}

/** Rectangles of the overlays that must stay visible over the site (`[data-app-occluder]`). */
function occluderRects(): WebAppBounds[] {
  return Array.from(document.querySelectorAll<HTMLElement>(OCCLUDERS), (o) => {
    const r = o.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

/**
 * A primitive that changes whenever one of those overlays appears, goes or changes its count:
 * toasts, guest knock cards (ADR-0040), the collapsed «Вызов…» strip (ADR-0034). The incoming /
 * outgoing call cards are dialogs and hide the view through useOverlayOpen.
 */
function useOccluderKey(): string {
  const toasts = useToasts((s) => s.items.length);
  const knocks = useAdmissions((s) => s.toasts.length);
  const strip = useCall((s) => s.phase === 'outgoing' && s.collapsed);
  return `${toasts}:${knocks}:${strip ? 1 : 0}`;
}

/**
 * The placeholder the main-process view (main/webApps.ts) is laid over: its rectangle is sent on
 * open and whenever it changes size (ResizeObserver: window resize, banners, zoom). Leaving the
 * app (rooms, another app) or an overlay hides the view; main keeps it alive (LRU 2). Toasts,
 * knock cards and the calling strip are never hidden behind the site: the view steps aside
 * (visibleViewRect) while they are shown.
 */
function DesktopView({ appId, url }: { appId: string; url: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const covered = useOverlayOpen();
  const occluders = useOccluderKey();
  const reloadKey = useWebApps((s) => s.reloadKey);
  const firstReload = useRef(reloadKey);
  const failed = useWebApps((s) => s.nav[appId]?.failed ?? '');
  const crashed = useWebApps((s) => s.nav[appId]?.crashed ?? false);
  const api = platform.webApps;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !api) return;
    if (covered) {
      setAppViewRect(null);
      void api.hide();
      return;
    }
    void api.open(appId, url, viewRect(el));
    return () => {
      setAppViewRect(null);
      void api.hide();
    };
  }, [api, appId, url, covered]);

  // Size changes and the overlays that must stay visible (re-measured after they are laid out).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !api || covered) return;
    let raf = 0;
    const push = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void api.setBounds(viewRect(el)));
    };
    const ro = new ResizeObserver(push);
    ro.observe(el);
    // The occluders present now; a new one changes useOccluderKey and re-runs this effect.
    for (const o of document.querySelectorAll(OCCLUDERS)) ro.observe(o);
    push();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [api, covered, occluders]);

  // «Перезагрузить» from the rail menu (after the open above: IPC keeps the order).
  useEffect(() => {
    if (reloadKey === firstReload.current) return;
    firstReload.current = reloadKey;
    void api?.navigate('reload');
  }, [api, reloadKey]);

  return (
    <div ref={ref} className="relative min-h-0 flex-1" data-testid="app-view" data-toast-anchor>
      {failed || crashed ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <p className="text-headline font-semibold">{crashed ? t('wapp.crashed') : t('wapp.failed')}</p>
            {failed ? <p className="text-caption text-muted">{failed}</p> : null}
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" onClick={() => void api?.openExternal()}>
                <ExternalLink className="size-4" aria-hidden /> {t('wapp.openInBrowser')}
              </Button>
              <Button onClick={() => void api?.navigate('reload')}>{t('wapp.retry')}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- web: an iframe

/** How long a frame may stay without `load` before «Открыть в новой вкладке» covers it (ADR-0050 §6). */
const FRAME_WAIT_MS = 4000;

/**
 * The web client's frame (ADR-0050 §6): sandboxed (scripts, same origin, forms, popups escaping
 * the sandbox, downloads — no top navigation), no referrer. Many sites refuse to be framed
 * (X-Frame-Options / frame-ancestors) and the client cannot tell reliably: without `load` in 4 s
 * the frame is covered by «Открыть в новой вкладке» (a one-shot timer), and the strip always has it.
 */
function WebFrame({ appId, url }: { appId: string; url: string }): ReactNode {
  const reloadKey = useWebApps((s) => s.reloadKey);
  // A new address or ⟳: a new frame with fresh state.
  return <FrameBody key={`${url}:${reloadKey}`} appId={appId} url={url} />;
}

/**
 * The frame's sandbox. allow-scripts + allow-same-origin is safe only for another origin: a page of
 * our own origin (an address pointing back at the web client) could lift its own sandbox and reach
 * the session, so it gets an opaque origin instead.
 */
function frameSandbox(url: string): string {
  let same = true;
  try {
    same = new URL(url).origin === window.location.origin;
  } catch {
    // an unparsable address: treated as ours (the strictest sandbox)
  }
  return `allow-scripts${same ? '' : ' allow-same-origin'} allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads`;
}

function FrameBody({ appId, url }: { appId: string; url: string }): ReactNode {
  const name = useWebApps((s) => s.byId[appId]?.name ?? '');
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), FRAME_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="relative min-h-0 flex-1 bg-white" data-testid="app-frame">
      <iframe
        src={url}
        title={name}
        sandbox={frameSandbox(url)}
        referrerPolicy="no-referrer"
        className="absolute inset-0 size-full border-0"
        onLoad={() => setLoaded(true)}
      />
      {slow && !loaded ? (
        <div className="mat-content absolute inset-0 grid place-items-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-body text-muted">{t('wapp.blocked')}</p>
            <Button onClick={() => openAppInBrowser(url)} data-testid="app-frame-open-tab">
              <ExternalLink className="size-4" aria-hidden /> {t('wapp.openInNewTab')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

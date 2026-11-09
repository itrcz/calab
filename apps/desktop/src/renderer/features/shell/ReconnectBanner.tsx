import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { useSession } from '../../stores/session';

/**
 * «Нет соединения — переподключаемся…» as an overlay (#41): a zero-height anchor right under the
 * title bar and a solid pill on top of it, so showing/hiding never moves the layout. The pill is
 * pointer-events-none: it never intercepts a click on the room header under it. Solid material,
 * no blur, no animation (docs/08, CLAUDE.md perf rules).
 */
export function ReconnectBanner(): ReactNode {
  // Above z-sticky: the sticky room header comes later in the DOM at the same z and covered the pill.
  // A leaf with its own subscriber (CLAUDE.md «Ререндеры»): the gateway is down (lib/gateway/banner.ts:
  // only after a drop > 3 s) or the API answers with outages (services/serverHealth.ts, ADR-0166).
  const shown = useSession((s) => s.ready && (s.reconnectBanner || s.serverDegraded));
  if (!shown) return null;
  return (
    <div className="pointer-events-none relative z-[calc(var(--z-sticky)+1)] h-0" data-testid="reconnect-banner">
      <div
        role="status"
        className="absolute left-1/2 top-1 max-w-[calc(100%-24px)] -translate-x-1/2 truncate rounded-full bg-warn px-3 py-1 text-center text-caption font-medium text-black shadow-sm"
      >
        {t('gateway.reconnecting')}
      </div>
    </div>
  );
}

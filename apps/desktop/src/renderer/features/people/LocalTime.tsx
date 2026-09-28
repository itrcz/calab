import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { fmt, useTimeFormat } from '../../lib/format';
import { localClock, localTimeZone, zoneDiffHint } from '../../lib/timezone';
import { t } from '../../i18n';
import { useWorkspaces } from '../../stores/workspaces';
import { useNow } from '../shell/voiceFormat';

type Variant = 'row' | 'line' | 'menu';

/**
 * A member's local time (docs/09 #48): «UTC+3 · 14:05», and «на 2 ч впереди» in grey when their
 * offset differs from mine. Nothing when their zone is unset / unknown. `row` is a dt/dd pair for
 * the profile card's list, `line` sits under the name in the profile dialog, `menu` under the
 * member menu's title. The clock ticks on the shared 60 s ticker (one timer for all, docs/14).
 */
export function LocalTime({ userId, variant }: { userId: string; variant: Variant }): ReactNode {
  const tz = useWorkspaces((s) => s.users[userId]?.timezone ?? '');
  // The ticker is subscribed only while a zone is known (the inner component mounts).
  return tz ? <Clockline tz={tz} variant={variant} /> : null;
}

function Clockline({ tz, variant }: { tz: string; variant: Variant }): ReactNode {
  const now = useNow(60_000);
  useTimeFormat();
  const c = localClock(tz, localTimeZone(), new Date(now), fmt.timeIn);
  if (!c) return null;
  const hint = zoneDiffHint(c.diff);
  const main = (
    <span className="tabular-nums">
      {c.zone} · {c.time}
    </span>
  );
  const extra = hint ? <span className="text-muted"> · {hint}</span> : null;
  if (variant === 'row') {
    return (
      <>
        <dt className="text-muted">{t('people.tz.title')}</dt>
        <dd className="min-w-0 truncate" data-testid="local-time">
          {main}
          {extra}
        </dd>
      </>
    );
  }
  if (variant === 'menu') {
    return (
      <div className="truncate px-2 pb-1 text-micro text-muted" data-testid="local-time">
        {main}
        {hint ? ` · ${hint}` : null}
      </div>
    );
  }
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-body" title={t('people.tz.title')} data-testid="local-time">
      <Clock className="size-3.5 shrink-0 text-muted" aria-label={t('people.tz.title')} role="img" />
      <span className="min-w-0 truncate">
        {main}
        {extra}
      </span>
    </div>
  );
}

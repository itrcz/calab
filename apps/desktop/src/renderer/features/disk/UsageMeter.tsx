import { BILLING_BITS } from '@calaba/protocol';
import { TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Button, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { STORAGE_PACKS, usageBar } from '../../lib/disk';
import { fmt } from '../../lib/format';
import { planDisplayName, planKind } from '../../lib/plan';
import { watchUsage } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { useDiskUi } from '../../stores/diskUi';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { useBillingBits } from '../workspace/billing/access';

/**
 * The storage meter (ADR-0094 §6, docs/08 «Диск»): one bar with three segments — the Disk, its
 * trash, everything else (chat and board attachments, stickers) — and the caption «12,4 ГБ из
 * 300 ГБ · тариф Team»; from 90 % of the limit a warning line. The same component in the disk's
 * footer (`compact`), in «Место» and in «Тариф». It reads the workspace's DiskUsage (one object,
 * replaced on refetch) and the plan name — a primitive.
 */
const SEG = {
  disk: 'bg-accent',
  trash: 'bg-[var(--color-yellow)]',
  other: 'bg-[var(--color-label-tertiary)]',
} as const;

export function UsageMeter({ workspaceId, compact = false, legend = true }: { workspaceId: string; compact?: boolean; legend?: boolean }): ReactNode {
  const usage = useDisk((s) => s.usage[workspaceId]);
  const planName = useWorkspaces((s) => {
    const p = s.byId[workspaceId]?.ws.plan;
    return p ? planDisplayName(planKind(p), p.displayName) : '';
  });
  useEffect(() => watchUsage(workspaceId), [workspaceId]);
  if (!usage) return <div className={compact ? 'h-[22px]' : 'h-16'} aria-hidden />;
  const bar = usageBar(usage);
  const caption = bar.limit > 0 ? t('disk.usage.of', { used: fmt.size(bar.used), limit: fmt.size(bar.limit) }) : t('disk.usage.noLimit', { used: fmt.size(bar.used) });
  const pct = (n: number): string => `${Math.max(0, Math.min(100, n * 100))}%`;
  return (
    <div className={cx('flex min-w-0 flex-col', compact ? 'gap-1' : 'gap-2')} data-testid="disk-meter" data-warn={bar.warn || undefined}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className={cx('min-w-0 truncate tabular-nums', compact ? 'text-caption text-muted' : 'text-body text-fg')}>
          {caption}
          {planName ? <span className="text-muted">{` · ${t('disk.usage.plan', { plan: planName })}`}</span> : null}
        </span>
      </div>
      <div
        role="meter"
        aria-label={t('disk.usage.title')}
        aria-valuemin={0}
        aria-valuemax={bar.limit || bar.used}
        aria-valuenow={bar.used}
        aria-valuetext={caption}
        className={cx('flex w-full overflow-hidden rounded-full bg-[var(--color-fill-hover)]', compact ? 'h-1' : 'h-2')}
      >
        <span className={SEG.disk} style={{ width: pct(bar.disk) }} />
        <span className={SEG.trash} style={{ width: pct(bar.trash) }} />
        <span className={SEG.other} style={{ width: pct(bar.other) }} />
      </div>
      {legend && !compact ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted">
          <Legend tone={SEG.disk} label={t('disk.usage.disk')} bytes={Number(usage.diskBytes - usage.trashBytes)} />
          <Legend tone={SEG.trash} label={t('disk.usage.trash')} bytes={Number(usage.trashBytes)} />
          <Legend tone={SEG.other} label={t('disk.usage.other')} bytes={Number(usage.otherBytes)} />
        </ul>
      ) : null}
      {bar.warn && !compact ? (
        <p role="note" className="flex items-start gap-1.5 text-caption text-fg" data-testid="disk-meter-warn">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
          {bar.full ? t('disk.usage.full') : t('disk.usage.almost')}
        </p>
      ) : null}
    </div>
  );
}

function Legend({ tone, label, bytes }: { tone: string; label: string; bytes: number }): ReactNode {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cx('size-2 shrink-0 rounded-full', tone)} aria-hidden />
      <span>{label}</span>
      <span className="tabular-nums text-fg">{fmt.size(Math.max(0, bytes))}</span>
    </li>
  );
}

/** «Докупить место»: workspace settings → «Тариф», where the packs are (ADR-0094 §6). */
export function openBuyStorage(workspaceId: string): void {
  useDiskUi.getState().openDialog(null);
  useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId, tab: 'plan' });
}

/**
 * «Докупить место» in «Тариф» (ADR-0094 §6): the packs +10 ГБ … +1 ТБ with the monthly price;
 * buying is off until payments are switched on (ADR-0080 §0) — the buttons are disabled with
 * «Скоро». Shown to BILLING_VIEW.
 */
export function BuyStorage({ workspaceId }: { workspaceId: string }): ReactNode {
  const view = (useBillingBits(workspaceId) & BILLING_BITS.VIEW) !== 0n;
  if (!view) return null;
  return (
    <section className="flex flex-col gap-1.5" data-settings-row data-testid="disk-buy">
      <h3 className="px-1 text-caption font-semibold text-muted" data-settings-label>
        {t('disk.buy.title')}
      </h3>
      <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body">
        {STORAGE_PACKS.map((p) => (
          <div key={p.sku} className="flex min-h-10 items-center gap-3 border-b border-[var(--color-card-line)] px-3 py-2 last:border-b-0" data-testid="disk-pack">
            <span className="min-w-0 flex-1 font-medium">{t(`disk.pack.${p.gb}` as const)}</span>
            <span className="tabular-nums text-muted">{t(`disk.pack.price.${p.gb}` as const)}</span>
            <Tip label={t('disk.buy.soon')}>
              {/* A disabled button gets no pointer events: the wrapper carries the tooltip. */}
              <span tabIndex={0} className="inline-flex rounded-full">
                <Button size="sm" variant="secondary" disabled>
                  {t('disk.buy.add')}
                </Button>
              </span>
            </Tip>
          </div>
        ))}
      </div>
      <p className="px-1 text-caption text-faint">{t('disk.buy.footer')}</p>
    </section>
  );
}

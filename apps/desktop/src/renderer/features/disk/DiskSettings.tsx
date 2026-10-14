import { useEffect, useState, type ReactNode } from 'react';
import { Card, Row, Select, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { TRASH_DAYS, trashDaysOption, type TrashDays } from '../../lib/disk';
import { diskApi } from '../../services/disk';
import { toast } from '../../stores/toasts';
import { UsageMeter } from './UsageMeter';

/**
 * Workspace settings → «Диск» (ADR-0094 §1, DISK_MANAGE): how long deleted files stay in the
 * trash — never (default), 7, 30 or 90 days; the hourly sweep deletes older ones for good. The
 * storage meter for context. Saved on change; a refusal restores the stored value.
 */
export function DiskSettingsTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const [days, setDays] = useState<TrashDays | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    diskApi.trashDays(workspaceId).then(
      (n) => live && setDays(trashDaysOption(n)),
      (e: unknown) => {
        if (!live) return;
        setDays(0);
        toast.fail(e, t('disk.err.settings'));
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const change = (next: TrashDays): void => {
    const prev = days;
    setDays(next);
    setBusy(true);
    diskApi.setTrashDays(workspaceId, next).then(
      () => setBusy(false),
      (e: unknown) => {
        setDays(prev);
        setBusy(false);
        toast.fail(e, t('disk.err.settings'));
      },
    );
  };
  return (
    <>
      <Card title={t('disk.settings.trash')} footer={t('disk.settings.trashHint')}>
        <Row label={t('disk.settings.trashDays')}>
          {days === null ? (
            <Spinner className="size-4" />
          ) : (
            <span className="w-44">
              <Select value={String(days)} disabled={busy} onChange={(e) => change(Number(e.target.value) as TrashDays)} aria-label={t('disk.settings.trashDays')} data-testid="disk-trash-days">
                {TRASH_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? t('disk.settings.never') : t('disk.settings.after', { n: d })}
                  </option>
                ))}
              </Select>
            </span>
          )}
        </Row>
      </Card>
      <Card title={t('disk.usage.title')}>
        <div className="px-3 py-3">
          <UsageMeter workspaceId={workspaceId} />
        </div>
      </Card>
    </>
  );
}

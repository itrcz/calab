import { useEffect, useState, type ReactNode } from 'react';
import { Card, Row, Select, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { TRASH_DAYS, trashDaysOption, type TrashDays } from '../../lib/disk';
import { wikiApi } from '../../services/wiki';
import { toast } from '../../stores/toasts';

/**
 * Workspace settings → «Вики» (ADR-0096 §1, WIKI_MANAGE): how long deleted pages stay in the trash —
 * never (default), 7, 30 or 90 days, as the Disk. Saved on change; a refusal restores the value.
 */
export function WikiSettingsTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const [days, setDays] = useState<TrashDays | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    wikiApi.trashDays(workspaceId).then(
      (n) => live && setDays(trashDaysOption(n)),
      (e: unknown) => {
        if (!live) return;
        setDays(0);
        toast.fail(e, t('wiki.err.settings'));
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
    wikiApi.setTrashDays(workspaceId, next).then(
      () => setBusy(false),
      (e: unknown) => {
        setDays(prev);
        setBusy(false);
        toast.fail(e, t('wiki.err.settings'));
      },
    );
  };
  return (
    <Card title={t('wiki.settings.trash')} footer={t('wiki.settings.trashHint')}>
      <Row label={t('disk.settings.trashDays')}>
        {days === null ? (
          <Spinner className="size-4" />
        ) : (
          <span className="w-44">
            <Select value={String(days)} disabled={busy} onChange={(e) => change(Number(e.target.value) as TrashDays)} aria-label={t('disk.settings.trashDays')} data-testid="wiki-trash-days">
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
  );
}

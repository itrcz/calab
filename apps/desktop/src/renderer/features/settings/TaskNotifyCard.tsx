import { memo, type ReactNode } from 'react';
import { Card, Row, Toggle } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { TASK_NOTIFY_GROUPS, rowOn, withRow, type TaskNotifyRow } from '../../lib/boards/taskNotify';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { localAuthority } from '../identity/model';

const NONE: readonly number[] = [];

/**
 * Saves a row's switch (ADR-0089 §5): optimistic — the session's settings change at once, the
 * server's answer replaces them, an error puts the previous list back (unless something newer
 * already replaced it).
 */
async function saveRow(row: TaskNotifyRow, on: boolean): Promise<void> {
  const s = useSession.getState();
  const me = s.me;
  if (!me?.settings) return;
  const prev = me.settings.taskNotifyOff;
  const next = withRow(prev, row, on);
  s.set({ me: { ...me, settings: { ...me.settings, taskNotifyOff: next } } });
  try {
    const r = await api.me.update({ taskNotifyOff: { kinds: next } });
    if (r.me) useSession.getState().set({ me: r.me });
  } catch (e) {
    const cur = useSession.getState().me;
    if (cur?.settings && cur.settings.taskNotifyOff === next) {
      useSession.getState().set({ me: { ...cur, settings: { ...cur.settings, taskNotifyOff: prev } } });
    }
    toast.fail(e, t('err.ctx.save'));
  }
}

/** One trigger: subscribes to its own on/off (a boolean), so a switch re-renders only its row. */
const TriggerRow = memo(function TriggerRow({ row }: { row: TaskNotifyRow }): ReactNode {
  const on = useSession((s) => rowOn(s.me?.settings?.taskNotifyOff ?? NONE, row));
  const label = t(row.label);
  return (
    <Row label={label} hint={t(row.hint)}>
      <Toggle label={label} checked={on} disabled={row.locked} onChange={(v) => void saveRow(row, v)} />
    </Row>
  );
});

/**
 * Settings → Уведомления → «Задачи» (ADR-0089 §5): «Мне лично» and «Задачи, в которых
 * участвую», a switch per trigger; approvals are locked on («Всегда»). The same screen on the
 * phone. The workspace's «Задачи» level still turns them on or off as a whole.
 */
export function TaskNotifyCard(): ReactNode {
  const eligible = useSession((s) => !!s.me?.settings && !s.me.user?.isBot);
  const local = useSession((s) => localAuthority(s.authority));
  if (!eligible || !local) return null;
  return (
    <Card title={t('tn.card')} footer={t('tn.footer')}>
      {TASK_NOTIFY_GROUPS.map((g) => (
        <div key={g.id} role="group" aria-label={t(g.title)} data-testid={`task-notify-${g.id}`}>
          <div className="px-3 pt-2.5 pb-1 text-caption font-semibold text-muted">{t(g.title)}</div>
          <div className="divide-y divide-[var(--color-card-line)]">
            {g.rows.map((row) => (
              <TriggerRow key={row.id} row={row} />
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

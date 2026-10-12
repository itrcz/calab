import { WorkspaceRole } from '@calaba/protocol';
import { memo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { Card, Row, Toggle } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { MAX_RELAY_BOTS, TASK_NOTIFY_GROUPS, relayBotIds, rowOn, withBot, withRow, type TaskNotifyRow } from '../../lib/boards/taskNotify';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';
import { toast } from '../../stores/toasts';
import { localAuthority } from '../identity/model';

const NONE: readonly number[] = [];
const NO_BOTS: readonly string[] = [];

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
 * Saves a bot's switch of «Передавать боту» (ADR-0090 §5): the whole list, optimistic like
 * saveRow; `listed` are the bots shown (ids no longer listed are dropped).
 */
async function saveBot(id: string, on: boolean, listed: readonly string[]): Promise<void> {
  const s = useSession.getState();
  const me = s.me;
  if (!me?.settings) return;
  const prev = me.settings.taskNotifyBots;
  const next = withBot(prev, id, on, listed);
  s.set({ me: { ...me, settings: { ...me.settings, taskNotifyBots: next } } });
  try {
    const r = await api.me.update({ taskNotifyBots: { botUserIds: next } });
    if (r.me) useSession.getState().set({ me: r.me });
  } catch (e) {
    const cur = useSession.getState().me;
    if (cur?.settings && cur.settings.taskNotifyBots === next) {
      useSession.getState().set({ me: { ...cur, settings: { ...cur.settings, taskNotifyBots: prev } } });
    }
    toast.fail(e, t('err.ctx.save'));
  }
}

/** One bot: its own subscriptions (name, avatar, workspaces, on), so a switch re-renders one row. */
const BotRow = memo(function BotRow({ id, listed }: { id: string; listed: readonly string[] }): ReactNode {
  const name = useWorkspaces((s) => s.users[id]?.displayName ?? '');
  const fileId = useWorkspaces((s) => s.users[id]?.avatarFileId || undefined);
  const where = useWorkspaces((s) =>
    s.order
      .filter((w) => { const e = s.byId[w]; return !!e && e.role !== WorkspaceRole.GUEST && !!e.members[id]; })
      .map((w) => s.byId[w]?.ws.name ?? '')
      .join(', '),
  );
  const on = useSession((s) => (s.me?.settings?.taskNotifyBots ?? NO_BOTS).includes(id));
  const full = useSession((s) => (s.me?.settings?.taskNotifyBots ?? NO_BOTS).length >= MAX_RELAY_BOTS);
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-2 mobile:tap-min-h" data-settings-row data-testid={`task-relay-bot-${id}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar userId={id} name={name} fileId={fileId} size={28} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body" data-settings-label>{name}</span>
          <span className="truncate text-caption text-faint">{where}</span>
        </div>
      </div>
      <Toggle label={name} checked={on} disabled={!on && full} onChange={(v) => void saveBot(id, v, listed)} />
    </div>
  );
});

/**
 * «Передавать боту» (ADR-0090 §5): a switch per bot of my workspaces; the server relays my task
 * notices (by the switches above) to the chosen ones. Hidden when there is no bot.
 */
function RelayGroup(): ReactNode {
  const ids = useWorkspaces(
    useShallow((s) =>
      relayBotIds(
        s.order.map((w) => {
          const e = s.byId[w];
          return { guest: !e || e.role === WorkspaceRole.GUEST, memberIds: e ? Object.keys(e.members) : [] };
        }),
        (u) => !!s.users[u]?.isBot,
      ),
    ),
  );
  if (ids.length === 0) return null;
  return (
    <div role="group" aria-label={t('tn.groupRelay')} data-testid="task-notify-relay">
      <div className="px-3 pt-2.5 pb-1 text-caption font-semibold text-muted">{t('tn.groupRelay')}</div>
      <div className="divide-y divide-[var(--color-card-line)]">
        {ids.map((id) => (
          <BotRow key={id} id={id} listed={ids} />
        ))}
      </div>
      <p className="px-3 pt-1 pb-2.5 text-caption text-faint">{t('tn.relayHint')}</p>
    </div>
  );
}

/**
 * Settings → Уведомления → «Задачи» (ADR-0089 §5): «Мне лично» and «Задачи, в которых
 * участвую», a switch per trigger; approvals are locked on («Всегда»). The same screen on the
 * phone. The workspace's «Задачи» level still turns them on or off as a whole. At the bottom,
 * «Передавать боту» (ADR-0090).
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
      <RelayGroup />
    </Card>
  );
}

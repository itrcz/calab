import { create } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  BoardStatusType,
  BoardTemplate,
  BoardWebhookPauseReason,
  EstimateScale,
  BoardFeature,
  PermissionTargetType,
  RoomPermissionOverrideSchema,
  WorkspaceRole,
  type Board,
  type BoardStatus,
  type BoardWebhook,
  type Role,
} from '@calaba/protocol';
import { Archive, ChevronDown, ChevronUp, Copy, Diamond, GitBranch, Plus, Settings2, ShieldCheck, Star, Tag, ToggleRight, Trash2, CircleDot, Webhook, Workflow, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { PlanLock } from '../../components/PlanLock';
import { Avatar } from '../../components/Avatar';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';
import { useUi } from '../../stores/ui';
import { Button, Card, Field, IconButton, Input, Modal, Row, Select, Spinner, Switch, Tip, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ESTIMATE_SCALES, FEATURES, featureOn, withFeature } from '../../lib/boards/features';
import { fmt } from '../../lib/format';
import { accessLevelOf, accessSteps, compactDrafts, mayManageIntegrations, triOf, withTri, type AccessLevel, type OverrideDraft, type Tri } from '../../lib/permissions';
import { planHas } from '../../lib/plan';
import { isFullRole } from '../../lib/roles';
import {
  createBoard,
  createLabel,
  createMilestone,
  copyText,
  createStatus,
  deleteLabel,
  deleteWebhook,
  loadWebhook,
  pingWebhook,
  saveWebhook,
  setBoardFeatures,
  setEstimateScale,
  deleteMilestone,
  moveStatus,
  openBoard,
  removeBoard,
  updateBoard,
  updateLabel,
  updateMilestone,
  updateStatus,
} from '../../services/boards';
import { boardsApi } from '../../services/boardsApi';
import { useBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { toast } from '../../stores/toasts';
import { myUserId } from '../../stores/session';
import { memberName, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { EmojiPicker } from '../chat/EmojiPicker';
import { RoleMark, roleName } from '../people/MemberBits';
import { MemberPicker } from '../people/MemberPicker';
import { memberItems, type PeoplePickItem, type RolePickItem } from '../people/memberPickItems';
import { CommitInput } from '../settings/CommitInput';
import { AccessLevelPicker } from '../workspace/AccessLevel';
import { TriToggle } from '../workspace/RoomDialogs';
import { GitTab } from './GitSettings';
import { DeleteStatusDialog } from './Kanban';
import { RulesTab } from './Rules';
import { CREATE_TASKS, EDIT_TASKS, MANAGE_BOARD, VIEW_BOARD, sortedStatuses } from './model';
import { Dot, PALETTE, STATUS_TYPES, STATUS_TYPE_LABEL, StatusIcon, colorCss } from './visuals';

/**
 * Board settings (ADR-0042 §5): «Основное» (name, key — locked after the first task, emoji,
 * description, auto-archive), «Статусы», «Лейблы», «Вехи» (the same pieces as in place),
 * «Доступ» (as a room's: roles and people, allow / deny of the four board bits, private board),
 * «Архив и удаление» (delete asks for the key). The create dialog picks a status template.
 */
export function BoardSettingsHost({ screen = false }: { screen?: boolean }): ReactNode {
  const req = useBoardsUi((s) => s.settingsFor);
  const phone = useUi((s) => s.phone.on);
  const close = (): void => useBoardsUi.getState().openSettings(null);
  if (!req) return null;
  if (!req.boardId) return <CreateBoardDialog workspaceId={req.workspaceId} onClose={close} />;
  // On the phone the settings are a screen of their own (features/shell/SettingsScreen.tsx).
  if (phone && !screen) return null;
  return <BoardSettings boardId={req.boardId} tab={req.tab} onClose={close} />;
}

function BoardSettings({ boardId, tab, onClose }: { boardId: string; tab: string | undefined; onClose: () => void }): ReactNode {
  const board = useBoards((s) => s.boards[boardId]);
  // «Вебхук» (ADR-0058 §4): MANAGE_BOARD (this window) and MANAGE_INTEGRATIONS of the workspace.
  const integrations = mayManageIntegrations(useMemberRoles(board?.workspaceId, myUserId()));
  if (!board) return null;
  const sections: SettingsSection[] = [
    { id: 'general', label: t('boards.set.general'), icon: Settings2, content: <GeneralTab board={board} /> },
    { id: 'features', label: t('boards.set.features'), icon: ToggleRight, content: <FeaturesTab board={board} /> },
    { id: 'statuses', label: t('boards.set.statuses'), icon: CircleDot, content: <StatusesTab board={board} /> },
    { id: 'labels', label: t('boards.set.labels'), icon: Tag, content: <LabelsTab board={board} /> },
    { id: 'milestones', label: t('boards.set.milestones'), icon: Diamond, content: <MilestonesTab board={board} /> },
    { id: 'access', label: t('boards.access'), icon: ShieldCheck, content: <AccessTab board={board} /> },
    // Automations (ADR-0060 §6): every manager of the board; Git also needs MANAGE_INTEGRATIONS.
    ...(featureOn(board.disabledFeatures, BoardFeature.AUTOMATIONS) ? [{ id: 'rules', label: t('rules.tab'), icon: Workflow, content: <RulesTab board={board} /> }] : []),
    ...(integrations && featureOn(board.disabledFeatures, BoardFeature.GIT_LINKS) ? [{ id: 'git', label: t('git.tab'), icon: GitBranch, content: <GitTab board={board} /> }] : []),
    ...(integrations ? [{ id: 'webhook', label: t('boards.set.webhook'), icon: Webhook, content: <WebhookTab board={board} /> }] : []),
    { id: 'danger', label: t('boards.set.danger'), icon: Archive, content: <DangerTab board={board} onDone={onClose} />, destructive: true },
  ];
  return <SettingsWindow title={board.name} titleIcon={<span className="text-headline leading-none">{board.emoji || '📋'}</span>} sections={sections} initial={tab ?? 'general'} onClose={onClose} />;
}

async function patch(boardId: string, init: Parameters<typeof updateBoard>[1]): Promise<void> {
  const b = await updateBoard(boardId, init);
  if (!b) throw new Error('refused');
}

function GeneralTab({ board }: { board: Board }): ReactNode {
  return (
    <>
      <Card title={t('card.basics')}>
        <Row label={t('boards.set.name')}>
          <CommitInput label={t('boards.set.name')} value={board.name} maxLength={60} onCommit={(v) => (v ? patch(board.id, { name: v }) : undefined)} />
        </Row>
        <Row label={t('boards.set.key')} hint={board.keyLocked ? t('boards.set.keyLocked') : t('boards.set.keyHint')}>
          {board.keyLocked ? (
            <span className="font-mono text-body" data-testid="board-key">
              {board.key}
            </span>
          ) : (
            <CommitInput label={t('boards.set.key')} value={board.key} maxLength={6} onCommit={(v) => (v ? patch(board.id, { key: v.toUpperCase() }) : undefined)} />
          )}
        </Row>
        <Row label={t('boards.set.emoji')}>
          <EmojiPicker label={t('boards.set.emoji')} inModal onPick={(e) => void patch(board.id, { emoji: e })} closeOnPick>
            <button type="button" className="grid size-8 place-items-center rounded-[var(--radius-icon)] border border-line text-headline hover:bg-hover">
              {board.emoji || '📋'}
            </button>
          </EmojiPicker>
        </Row>
        <Row label={t('boards.set.description')}>
          <CommitInput label={t('boards.set.description')} value={board.description} maxLength={2000} onCommit={(v) => patch(board.id, { description: v })} />
        </Row>
      </Card>
      <Card title={t('boards.set.archiveCard')} footer={t('boards.set.autoArchiveHint')}>
        <Row label={t('boards.set.autoArchive')}>
          <Select value={String(board.autoArchiveDays)} onChange={(e) => void patch(board.id, { autoArchiveDays: Number(e.target.value) })} data-testid="auto-archive">
            {[0, 7, 14, 30, 60, 90].map((d) => (
              <option key={d} value={d}>
                {d ? t('boards.set.days', { n: d }) : t('boards.set.never')}
              </option>
            ))}
          </Select>
        </Row>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ features (ADR-0058 §3)

/**
 * «Фичи»: every switchable feature of the board (data of a switched-off one is kept and comes
 * back when it is on again) and the estimate scale. MANAGE_BOARD; one PATCH per change.
 */
function FeaturesTab({ board }: { board: Board }): ReactNode {
  const disabled = board.disabledFeatures;
  const scale = board.estimateScale || EstimateScale.FIBONACCI;
  return (
    <>
      <Card title={t('boards.feat.card')} footer={t('boards.feat.footer')}>
        <div data-testid="board-features">
          {FEATURES.map((f) => (
            <Row key={f.feature} label={t(f.label)} hint={t(f.hint)}>
              <Toggle label={t(f.label)} checked={featureOn(disabled, f.feature)} onChange={(v) => void setBoardFeatures(board.id, withFeature(disabled, f.feature, v))} />
            </Row>
          ))}
        </div>
      </Card>
      <Card title={t('boards.scale.card')} footer={t('boards.scale.footer')}>
        <Row label={t('boards.scale.label')}>
          <Select value={String(scale)} onChange={(e) => void setEstimateScale(board.id, Number(e.target.value))} aria-label={t('boards.scale.label')} data-testid="estimate-scale">
            {ESTIMATE_SCALES.map((x) => (
              <option key={x.scale} value={x.scale}>
                {t(x.label)}
              </option>
            ))}
          </Select>
        </Row>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ webhook (ADR-0058 §4)

const tsText = (ts: Parameters<typeof timestampDate>[0] | undefined): string => (ts ? fmt.full(timestampDate(ts)) : '');

/**
 * «Вебхук»: one https address per board that gets every change of its tasks as JSON. The secret
 * is shown once, right after a save; «Проверить» sends a ping; the status tells the last
 * delivery, the failure and why delivery is paused. Business plan only: below it the form is
 * locked (a configured webhook stays, paused — ADR-0058 §5).
 */
function WebhookTab({ board }: { board: Board }): ReactNode {
  const allowed = useWorkspaces((s) => planHas(s.byId[board.workspaceId]?.ws.plan, 'boardWebhooks'));
  const [hook, setHook] = useState<BoardWebhook | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [shown, setShown] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    loadWebhook(board.id, ac.signal).then(
      (w) => {
        setHook(w);
        setUrl(w?.url ?? '');
        setState('ready');
      },
      () => !ac.signal.aborted && setState('error'),
    );
    return () => ac.abort();
  }, [board.id]);
  if (state === 'loading') {
    return (
      <div className="grid h-24 place-items-center">
        <Spinner />
      </div>
    );
  }
  if (state === 'error') return <p className="px-1 text-body text-danger-text">{t('boards.hook.loadFailed')}</p>;
  const save = async (): Promise<void> => {
    setBusy(true);
    const r = await saveWebhook(board.workspaceId, board.id, url.trim(), secret.trim());
    setBusy(false);
    if (!r) return;
    setHook(r.webhook);
    setSecret('');
    setShown(r.secret);
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('boards.hook.deleteTitle'), t('boards.hook.deleteText'), t('common.delete')))) return;
    if (await deleteWebhook(board.workspaceId, board.id)) {
      setHook(null);
      setUrl('');
      setShown('');
    }
  };
  const ping = async (): Promise<void> => {
    setBusy(true);
    await pingWebhook(board.workspaceId, board.id);
    setBusy(false);
    const w = await loadWebhook(board.id).catch(() => null);
    if (w) setHook(w);
  };
  const form = (
    <Card title={t('boards.hook.card')} footer={t('boards.hook.footer')}>
      <Row label={t('boards.hook.url')} hint={t('boards.hook.urlHint')}>
        <Input className="w-80" type="url" value={url} maxLength={2048} placeholder="https://" onChange={(e) => setUrl(e.target.value)} aria-label={t('boards.hook.url')} data-testid="webhook-url" />
      </Row>
      <Row label={t('boards.hook.secret')} hint={hook?.hasSecret ? t('boards.hook.secretKept') : t('boards.hook.secretHint')}>
        <Input className="w-80" value={secret} maxLength={256} placeholder={t('boards.hook.secretAuto')} onChange={(e) => setSecret(e.target.value)} aria-label={t('boards.hook.secret')} data-testid="webhook-secret" />
      </Row>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button size="sm" busy={busy} disabled={!/^https:\/\/\S+$/i.test(url.trim())} onClick={() => void save()} data-testid="webhook-save">
          {hook ? t('common.save') : t('boards.hook.create')}
        </Button>
        {hook ? (
          <>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void ping()} data-testid="webhook-ping">
              {t('boards.hook.ping')}
            </Button>
            <span className="flex-1" />
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()} data-testid="webhook-delete">
              <Trash2 className="size-3.5" aria-hidden /> {t('common.delete')}
            </Button>
          </>
        ) : null}
      </div>
    </Card>
  );
  return (
    <>
      {shown ? (
        <Card title={t('boards.hook.secretOnce')} footer={t('boards.hook.secretOnceHint')}>
          <div className="flex items-center gap-2 px-3 py-2" data-testid="webhook-secret-shown">
            <code className="selectable min-w-0 flex-1 truncate font-mono text-caption">{shown}</code>
            <Button size="sm" variant="secondary" onClick={() => copyText(shown, t('boards.hook.secretCopied'))}>
              <Copy className="size-3.5" aria-hidden /> {t('boards.hook.copy')}
            </Button>
          </div>
        </Card>
      ) : null}
      {allowed ? form : <PlanLock plan="business" testId="webhook-lock">{form}</PlanLock>}
      {hook ? <WebhookStatus hook={hook} board={board} /> : null}
    </>
  );
}

/** The state of the deliveries: paused (plan, archive), disabled, failing, the last success, the queue. */
function WebhookStatus({ hook, board }: { hook: BoardWebhook; board: Board }): ReactNode {
  const lines: Array<{ key: string; text: string; tone?: 'danger' | 'warn' }> = [];
  if (hook.pausedReason === BoardWebhookPauseReason.PLAN) lines.push({ key: 'plan', text: t('boards.hook.pausedPlan'), tone: 'warn' });
  if (board.archivedAt) lines.push({ key: 'archived', text: t('boards.hook.pausedArchived'), tone: 'warn' });
  if (!hook.enabled) lines.push({ key: 'off', text: t('boards.hook.disabled', { date: tsText(hook.disabledAt) }), tone: 'danger' });
  else if (hook.failingSince) lines.push({ key: 'fail', text: t('boards.hook.failing', { date: tsText(hook.failingSince) }), tone: 'danger' });
  if (hook.lastError) lines.push({ key: 'err', text: t('boards.hook.lastError', { error: hook.lastError }), tone: 'danger' });
  lines.push({ key: 'ok', text: hook.lastOkAt ? t('boards.hook.lastOk', { date: tsText(hook.lastOkAt) }) : t('boards.hook.neverOk') });
  if (hook.pending) lines.push({ key: 'queue', text: t('boards.hook.pending', { n: hook.pending }) });
  if (hook.createdBy) lines.push({ key: 'by', text: t('boards.hook.createdBy', { name: memberName(board.workspaceId, hook.createdBy) }) });
  return (
    <Card title={t('boards.hook.status')}>
      <ul className="flex flex-col gap-1 px-3 py-2.5 text-body" data-testid="webhook-status">
        {lines.map((l) => (
          <li key={l.key} className={cx('break-words', l.tone === 'danger' ? 'text-danger-text' : l.tone === 'warn' ? 'text-warn' : 'text-muted')}>
            {l.text}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ColorDot({ color, onPick }: { color: number; onPick: (c: number) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button type="button" aria-label={t('boards.color')} onClick={() => setOpen(!open)} className="grid size-6 place-items-center rounded-full hover:bg-hover">
        <Dot color={color} size={12} />
      </button>
      {open ? (
        <div className="mat-popover absolute left-0 top-7 z-[var(--z-modal-popover)] grid grid-cols-6 gap-1.5 rounded-[var(--radius-card)] p-2">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={colorCss(c)}
              onClick={() => {
                setOpen(false);
                onPick(c);
              }}
              className={cx('size-6 rounded-full', c === color && 'ring-2 ring-fg ring-offset-2 ring-offset-[var(--color-popover)]')}
              style={{ background: colorCss(c) }}
            />
          ))}
        </div>
      ) : null}
    </span>
  );
}

function StatusesTab({ board }: { board: Board }): ReactNode {
  const list = sortedStatuses(board);
  const [deleting, setDeleting] = useState<BoardStatus | null>(null);
  return (
    <Card title={t('boards.set.statuses')} footer={t('boards.set.statusesHint')}>
      <div className="flex flex-col" data-testid="statuses-editor">
        {list.map((s, i) => (
          <div key={s.id} className="flex h-11 items-center gap-2 border-b border-[var(--color-card-line)] px-3 last:border-b-0" data-settings-row>
            <ColorDot color={s.color} onPick={(color) => void updateStatus(board.id, s.id, { color })} />
            <StatusIcon type={s.type} color={s.color} />
            <CommitInput className="w-44" label={t('boards.set.name')} value={s.name} maxLength={32} onCommit={(v) => (v ? updateStatus(board.id, s.id, { name: v }).then(() => undefined) : undefined)} />
            <Select className="w-36" value={String(s.type)} onChange={(e) => void updateStatus(board.id, s.id, { type: Number(e.target.value) })} aria-label={t('boards.statusType')}>
              {STATUS_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(STATUS_TYPE_LABEL[ty] ?? 'boards.type.unstarted')}
                </option>
              ))}
            </Select>
            <span className="flex-1" />
            <Tip label={s.isDefault ? t('boards.defaultStatus') : t('boards.makeDefault')}>
              <button
                type="button"
                aria-pressed={s.isDefault}
                aria-label={s.isDefault ? t('boards.defaultStatus') : t('boards.makeDefault')}
                onClick={() => !s.isDefault && void updateStatus(board.id, s.id, { isDefault: true })}
                className={cx('grid size-6 place-items-center rounded-full hover:bg-hover', s.isDefault ? 'text-[var(--color-role-owner)]' : 'text-faint hover:text-fg')}
              >
                <Star className="size-3.5" fill={s.isDefault ? 'currentColor' : 'none'} aria-hidden />
              </button>
            </Tip>
            <button type="button" aria-label={t('boards.moveUp')} disabled={i === 0} onClick={() => void moveStatus(board.id, s.id, i - 1)} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover disabled:opacity-30">
              <ChevronUp className="size-4" aria-hidden />
            </button>
            <button type="button" aria-label={t('boards.moveDown')} disabled={i === list.length - 1} onClick={() => void moveStatus(board.id, s.id, i + 1)} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover disabled:opacity-30">
              <ChevronDown className="size-4" aria-hidden />
            </button>
            <button type="button" aria-label={t('boards.deleteStatus')} disabled={s.isDefault || list.length < 2} onClick={() => setDeleting(s)} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-danger disabled:opacity-30">
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
        <div className="px-3 py-2">
          <Button variant="secondary" size="sm" onClick={() => void createStatus(board.id, { name: t('boards.newStatus'), type: BoardStatusType.UNSTARTED, color: 0xaeaeb2 })} disabled={list.length >= 20} data-testid="status-add">
            <Plus className="size-3.5" aria-hidden /> {t('boards.addColumn')}
          </Button>
        </div>
      </div>
      {deleting ? <DeleteStatusDialog boardId={board.id} status={deleting} statuses={list} onClose={() => setDeleting(null)} /> : null}
    </Card>
  );
}

function LabelsTab({ board }: { board: Board }): ReactNode {
  const [name, setName] = useState('');
  const list = [...board.labels].sort((a, b) => a.position - b.position);
  const add = (): void => {
    const n = name.trim();
    if (!n) return;
    setName('');
    void createLabel(board.id, { name: n, color: PALETTE[(list.length * 5 + 2) % PALETTE.length] ?? 0x0a84ff });
  };
  return (
    <Card title={t('boards.set.labels')}>
      <div className="flex flex-col" data-testid="labels-editor">
        {list.map((l) => (
          <div key={l.id} className="flex h-11 items-center gap-2 border-b border-[var(--color-card-line)] px-3" data-settings-row>
            <ColorDot color={l.color} onPick={(color) => void updateLabel(board.id, l.id, { color })} />
            <CommitInput className="w-56" label={t('boards.set.name')} value={l.name} maxLength={32} onCommit={(v) => (v ? updateLabel(board.id, l.id, { name: v }).then(() => undefined) : undefined)} />
            <span className="flex-1" />
            <button type="button" aria-label={t('common.delete')} onClick={() => void deleteLabel(board.id, l.id)} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-danger">
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
        <form
          className="flex items-center gap-2 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder={t('boards.labelName')} className="w-56" data-testid="label-name" />
          <Button variant="secondary" size="sm" type="submit" disabled={!name.trim() || list.length >= 50}>
            <Plus className="size-3.5" aria-hidden /> {t('boards.addLabel')}
          </Button>
        </form>
      </div>
    </Card>
  );
}

function MilestonesTab({ board }: { board: Board }): ReactNode {
  const [name, setName] = useState('');
  const [due, setDue] = useState('');
  const list = [...board.milestones].sort((a, b) => a.position - b.position);
  return (
    <Card title={t('boards.set.milestones')} footer={t('boards.set.milestonesHint')}>
      <div className="flex flex-col">
        {list.map((m) => (
          <div key={m.id} className="flex h-11 items-center gap-2 border-b border-[var(--color-card-line)] px-3" data-settings-row>
            <Diamond className="size-3.5 text-muted" aria-hidden />
            <CommitInput className="w-56" label={t('boards.set.name')} value={m.name} maxLength={60} onCommit={(v) => (v ? updateMilestone(board.id, m.id, { name: v }).then(() => undefined) : undefined)} />
            <input type="date" value={m.dueOn} onChange={(e) => void updateMilestone(board.id, m.id, { dueOn: e.target.value })} className="h-7 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-control" aria-label={t('boards.f.dueOn')} />
            <span className="flex-1" />
            <button type="button" aria-label={t('common.delete')} onClick={() => void deleteMilestone(board.id, m.id)} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-danger">
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
        <form
          className="flex items-center gap-2 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void createMilestone(board.id, { name: name.trim(), dueOn: due });
            setName('');
            setDue('');
          }}
        >
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('boards.milestoneName')} className="w-56" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="h-7 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-control" aria-label={t('boards.f.dueOn')} />
          <Button variant="secondary" size="sm" type="submit" disabled={!name.trim()}>
            <Plus className="size-3.5" aria-hidden /> {t('boards.addMilestone')}
          </Button>
        </form>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ access

const BITS: ReadonlyArray<{ bit: bigint; label: 'boards.perm.view' | 'boards.perm.create' | 'boards.perm.edit' | 'boards.perm.manage'; hint: 'boards.perm.viewHint' | 'boards.perm.createHint' | 'boards.perm.editHint' | 'boards.perm.manageHint' }> = [
  { bit: VIEW_BOARD, label: 'boards.perm.view', hint: 'boards.perm.viewHint' },
  { bit: CREATE_TASKS, label: 'boards.perm.create', hint: 'boards.perm.createHint' },
  { bit: EDIT_TASKS, label: 'boards.perm.edit', hint: 'boards.perm.editHint' },
  { bit: MANAGE_BOARD, label: 'boards.perm.manage', hint: 'boards.perm.manageHint' },
];

const key = (o: Pick<OverrideDraft, 'targetType' | 'targetId'>): string => `${o.targetType}:${o.targetId}`;

/**
 * «Позванные по карточкам: N» on a closed board (ADR-0076): the members who see it only through
 * cards they were invited to (assignee, approver, watcher). Its own fetch: nothing else re-renders.
 */
function TaskScopedCount({ boardId }: { boardId: string }): ReactNode {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void boardsApi
      .permissions(boardId)
      .then((r) => live && setN(r.taskScopedCount))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [boardId]);
  if (n === null) return null;
  return (
    <Tip label={t('boards.invitedByCardsHint')}>
      <p className="mt-2 text-caption text-muted" tabIndex={0} data-testid="board-access-invited">
        {t('boards.invitedByCards', { n })}
      </p>
    </Tip>
  );
}

/** «Доступ» (the room access UI, ADR-0042 §2): targets on the left, the four board bits on the right. */
function AccessTab({ board }: { board: Board }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[board.workspaceId]);
  const roles = useMemo(() => entry?.roles ?? [], [entry?.roles]);
  const members = entry?.members;
  const [drafts, setDrafts] = useState<OverrideDraft[]>(() => board.permissionOverrides.map((o) => ({ targetType: o.targetType, targetId: o.targetId, allow: o.allow, deny: o.deny })));
  const memberRole = roles.find((r) => r.builtin === WorkspaceRole.MEMBER)?.id ?? 'member';
  const [selected, setSelected] = useState(`${PermissionTargetType.ROLE}:${memberRole}`);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // A restricted board (ADR-0048): admins are plain members there — their role becomes a target; only the owner is fixed.
  const restricted = board.restricted;
  const targetable = useCallback((r: Pick<Role, 'builtin'>): boolean => (restricted ? r.builtin !== WorkspaceRole.OWNER : !isFullRole(r)), [restricted]);
  const targets = useMemo(() => {
    const rs = roles.filter((r) => targetable(r) && r.builtin !== WorkspaceRole.GUEST).map((r) => ({ key: `${PermissionTargetType.ROLE}:${r.id}`, type: PermissionTargetType.ROLE, id: r.id, label: `@${roleName(r)}`, role: r }));
    const us = drafts.filter((d) => d.targetType === PermissionTargetType.USER).map((d) => ({ key: key(d), type: d.targetType, id: d.targetId, label: memberName(board.workspaceId, d.targetId), role: undefined }));
    return [...rs, ...us];
  }, [roles, drafts, board.workspaceId, targetable]);
  const current = targets.find((x) => x.key === selected) ?? targets[0];
  const draft = drafts.find((d) => current && key(d) === current.key);
  const save = (next: OverrideDraft[]): void => {
    setDrafts(next);
    setBusy(true);
    void boardsApi
      .setPermissions(board.id, { overrides: compactDrafts(next).map((d) => create(RoomPermissionOverrideSchema, d)) })
      .then((r) => r.board && useBoards.getState().upsertBoard(r.board))
      .catch((e: unknown) => {
        toast.fail(e, t('boards.err.save'));
        setDrafts(board.permissionOverrides.map((o) => ({ targetType: o.targetType, targetId: o.targetId, allow: o.allow, deny: o.deny })));
      })
      .finally(() => setBusy(false));
  };
  const setTri = (bit: bigint, v: Tri): void => {
    if (!current) return;
    const exists = drafts.some((d) => key(d) === current.key);
    const base = exists ? drafts : [...drafts, { targetType: current.type, targetId: current.id, allow: 0n, deny: 0n }];
    save(base.map((d) => (key(d) === current.key ? withTri(d, bit, v) : d)));
  };
  // «×» of a person's row: their whole override goes at once (as every bit back to neutral) and the
  // row leaves the list; roles are always listed, never removed.
  const removeUser = (k: string): void => {
    const d = drafts.find((x) => key(x) === k);
    const next = drafts.filter((x) => key(x) !== k);
    if (current?.key === k) setSelected(`${PermissionTargetType.ROLE}:${memberRole}`);
    if (d && (d.allow !== 0n || d.deny !== 0n)) save(next);
    else setDrafts(next); // only added here, never saved
  };
  // One or two PATCHes in order (lib/permissions accessSteps); the answer carries the new overrides
  // (turning «без администраторов» on gives me a personal allow), so the drafts follow the board.
  const setLevel = (to: AccessLevel): void => {
    setBusy(true);
    void accessSteps(accessLevelOf(board), to)
      .reduce<Promise<void>>((p, body) => p.then(() => patch(board.id, body)), Promise.resolve())
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        const b = useBoards.getState().boards[board.id];
        if (b) setDrafts(b.permissionOverrides.map((o) => ({ targetType: o.targetType, targetId: o.targetId, allow: o.allow, deny: o.deny })));
        setBusy(false);
      });
  };
  const pickGroups = useMemo((): Array<PickerGroup<PeoplePickItem>> => {
    const listed = new Set(drafts.filter((d) => d.targetType === PermissionTargetType.USER).map((d) => d.targetId));
    const people = memberItems(Object.values(members ?? {}), { roles, decorate: (m) => (m.role === WorkspaceRole.GUEST ? { disabled: true, note: t('boards.perm.noGuests') } : listed.has(m.user?.id ?? '') ? { note: t('picker.listed') } : undefined) });
    const rs: RolePickItem[] = roles
      .filter((r) => targetable(r) && r.builtin !== WorkspaceRole.GUEST)
      .map((r) => ({ kind: 'role', id: `role:${r.id}`, roleId: r.id, role: r.builtin, color: r.color, label: roleName(r), note: '', search: [roleName(r), r.name] }));
    return [
      { id: 'roles', label: t('picker.roles'), items: rs },
      { id: 'members', label: t('picker.members'), items: people },
    ];
  }, [drafts, members, roles, targetable]);
  return (
    <>
      {/* ADR-0048: Все участники / По списку / По списку, без администраторов (this tab is MANAGE_BOARD's). */}
      <Card title={t('boards.access')} footer={board.isPrivate ? t('boards.set.privateHint') : undefined}>
        <AccessLevelPicker value={accessLevelOf(board)} disabled={busy} onChange={(to) => setLevel(to)} />
        {restricted ? <TaskScopedCount boardId={board.id} /> : null}
      </Card>
      <div className="flex gap-4" data-testid="board-access">
        <div className="flex w-52 shrink-0 flex-col gap-0.5">
          {targets.map((x) => {
            const on = current?.key === x.key;
            const m = x.type === PermissionTargetType.USER ? members?.[x.id] : undefined;
            const user = x.type === PermissionTargetType.USER;
            return (
              <div key={x.key} className={cx('flex h-8 items-center rounded-[var(--radius-row)]', on ? 'bg-accent-strong text-accent-fg' : 'text-fg hover:bg-hover')} data-testid="board-access-target">
                <button type="button" aria-pressed={on} onClick={() => setSelected(x.key)} className={cx('flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-body', user && 'pr-0')}>
                  {m ? <Avatar userId={x.id} name={x.label} {...(m.user?.avatarFileId ? { fileId: m.user.avatarFileId } : {})} size={20} /> : null}
                  <span className="min-w-0 truncate">{x.label}</span>
                  {x.role ? <RoleMark role={x.role.builtin} tone={on ? 'inherit' : 'role'} /> : null}
                </button>
                {user ? (
                  <IconButton
                    size="sm"
                    label={t('perm.removeTarget', { name: x.label })}
                    className={cx('mr-0.5', on && 'text-accent-fg hover:text-accent-fg')}
                    disabled={busy}
                    onClick={() => removeUser(x.key)}
                    data-testid="board-access-remove"
                  >
                    <X className="size-3.5" aria-hidden />
                  </IconButton>
                ) : null}
              </div>
            );
          })}
          <MemberPicker
            open={adding}
            onOpenChange={setAdding}
            groups={pickGroups}
            onSelect={(item) => {
              setAdding(false);
              if (item.kind === 'role') {
                setSelected(`${PermissionTargetType.ROLE}:${item.roleId}`);
                return;
              }
              const d: OverrideDraft = { targetType: PermissionTargetType.USER, targetId: item.userId, allow: 0n, deny: 0n };
              if (!drafts.some((x) => key(x) === key(d))) setDrafts([...drafts, d]);
              setSelected(key(d));
            }}
            placeholder={t('picker.searchPeople')}
            label={t('perm.addUser')}
            testId="board-access-picker"
          >
            <Button variant="secondary" size="sm" className="mt-2 justify-start">
              <Plus className="size-3.5" aria-hidden /> {t('perm.addUser')}
            </Button>
          </MemberPicker>
        </div>
        <div className="min-w-0 flex-1">
          <table className="w-full overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body">
            <caption className="sr-only">{t('boards.access')}</caption>
            <tbody>
              {BITS.map((b) => (
                <tr key={b.label} className="border-b border-[var(--color-card-line)] last:border-b-0" data-settings-row>
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <span data-settings-label>{t(b.label)}</span>
                    <span className="block text-caption text-muted">{t(b.hint)}</span>
                  </th>
                  <td className="w-32 px-3 py-2 text-right">
                    <TriToggle label={t(b.label)} value={triOf(draft, b.bit)} onChange={(v) => setTri(b.bit, v)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-1 pt-2 text-caption text-muted">{t('boards.perm.footer')}</p>
        </div>
      </div>
    </>
  );
}

function DangerTab({ board, onDone }: { board: Board; onDone: () => void }): ReactNode {
  const [confirm, setConfirm] = useState(false);
  return (
    <Card title={t('boards.set.danger')}>
      <Row label={t('boards.archiveBoard')} hint={t('boards.archiveBoardText')}>
        <Button variant="secondary" onClick={() => void removeBoard(board.id, false).then((ok) => ok && onDone())}>
          <Archive className="size-3.5" aria-hidden /> {t('boards.archiveBoard')}
        </Button>
      </Row>
      <Row label={t('boards.deleteBoard')} hint={t('boards.deleteBoardHint')}>
        <Button variant="destructive" onClick={() => setConfirm(true)} data-testid="board-delete">
          <Trash2 className="size-3.5" aria-hidden /> {t('boards.deleteBoard')}
        </Button>
      </Row>
      {confirm ? <DeleteBoardDialog board={board} onClose={() => setConfirm(false)} onDone={onDone} /> : null}
    </Card>
  );
}

/** Deleting for good: type the board key to confirm (ADR-0042 §5). */
export function DeleteBoardDialog({ board, onClose, onDone }: { board: Board; onClose: () => void; onDone: () => void }): ReactNode {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('boards.deleteBoardTitle', { name: board.name })}
      description={t('boards.deleteBoardText', { key: board.key })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            busy={busy}
            disabled={v.trim().toUpperCase() !== board.key}
            onClick={() => {
              setBusy(true);
              void removeBoard(board.id, true).then((ok) => {
                setBusy(false);
                if (ok) {
                  onClose();
                  onDone();
                }
              });
            }}
            data-testid="board-delete-confirm"
          >
            {t('boards.deleteBoard')}
          </Button>
        </>
      }
    >
      <Field label={t('boards.typeKey', { key: board.key })}>
        <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} data-testid="board-delete-key" />
      </Field>
    </Modal>
  );
}

// ------------------------------------------------------------------ create

const TEMPLATES: ReadonlyArray<{ v: BoardTemplate; label: 'boards.tpl.simple' | 'boards.tpl.dev' | 'boards.tpl.empty'; hint: 'boards.tpl.simpleHint' | 'boards.tpl.devHint' | 'boards.tpl.emptyHint' }> = [
  { v: BoardTemplate.SIMPLE, label: 'boards.tpl.simple', hint: 'boards.tpl.simpleHint' },
  { v: BoardTemplate.DEVELOPMENT, label: 'boards.tpl.dev', hint: 'boards.tpl.devHint' },
  { v: BoardTemplate.EMPTY, label: 'boards.tpl.empty', hint: 'boards.tpl.emptyHint' },
];

/** «+ Доска» (CREATE_BOARDS, ADR-0048): name, key (derived when empty), emoji, private, template. */
export function CreateBoardDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [boardKey, setKey] = useState('');
  const [emoji, setEmoji] = useState('📋');
  const [priv, setPriv] = useState(false);
  const [tpl, setTpl] = useState<BoardTemplate>(BoardTemplate.SIMPLE);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (!name.trim()) return;
    setBusy(true);
    void createBoard(workspaceId, { name: name.trim(), key: boardKey.trim().toUpperCase(), emoji, isPrivate: priv, template: tpl }).then((b) => {
      setBusy(false);
      if (!b) return;
      onClose();
      openBoard(workspaceId, b.id);
    });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('boards.newBoard')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} busy={busy} disabled={!name.trim()} data-testid="create-board-submit">
            {t('common.create')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        data-testid="create-board"
      >
        <div className="flex items-end gap-2">
          <EmojiPicker label={t('boards.set.emoji')} inModal onPick={setEmoji} closeOnPick>
            <button type="button" className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-control)] border border-line text-headline hover:bg-hover">
              {emoji}
            </button>
          </EmojiPicker>
          <div className="min-w-0 flex-1">
            <Field label={t('boards.set.name')}>
              <Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="create-board-name" />
            </Field>
          </div>
          <div className="w-24">
            <Field label={t('boards.set.key')}>
              <Input value={boardKey} maxLength={6} placeholder="AUTO" onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} data-testid="create-board-key" />
            </Field>
          </div>
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="pb-1.5 text-caption font-medium text-muted">{t('boards.template')}</legend>
          {TEMPLATES.map((x) => (
            <label key={x.v} className={cx('flex cursor-default items-start gap-2.5 rounded-[var(--radius-card)] border px-3 py-2', tpl === x.v ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : 'border-line hover:bg-hover')}>
              <input type="radio" name="tpl" checked={tpl === x.v} onChange={() => setTpl(x.v)} className="mt-1 accent-[var(--color-accent)]" />
              <span className="flex flex-col">
                <span className="text-body font-medium">{t(x.label)}</span>
                <span className="text-caption text-muted">{t(x.hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Switch checked={priv} onChange={setPriv} label={t('boards.set.private')} hint={t('boards.set.privateHint')} />
      </form>
    </Modal>
  );
}

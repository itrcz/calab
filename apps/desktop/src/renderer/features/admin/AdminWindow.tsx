import { Plan, ScreenSharePreset, type AdminWorkspace, type PlanLogEntry } from '@calaba/protocol';
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import * as DialogP from '@radix-ui/react-dialog';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, CloseButton, Empty, Input, Row, Segmented, Select, Spinner, Toggle, cx } from '../../components/ui';
import { plural, t, type MessageKey } from '../../i18n';
import { adminApi } from '../../lib/api/endpoints';
import { onApiError } from '../../lib/api/client';
import { errorText, recentAuthRequired } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { audioTierLabel } from '../../lib/audioTierLabel';
import {
  AUDIO_CAP_OPTIONS,
  NOTE_MAX,
  PLAN_LABEL,
  inputFromDate,
  limitsFormFrom,
  planKind,
  setPlanBody,
  type LimitsField,
  type LimitsForm,
  type PlanForm,
} from '../../lib/plan';
import { platform } from '../../platform';
import { toast } from '../../stores/toasts';
import { ExpiredBadge, PlanPill } from '../workspace/PlanTab';
import { SuspendedBadge, SuspendedMark, SuspensionCard } from './SuspensionCard';
import { LocalReauth } from '../identity/SignIn';

/** The search waits this long after the last keystroke (admin API: 60 requests / min). */
export const SEARCH_DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const KEY = { search: (q: string) => ['admin', 'search', q] as const, ws: (id: string) => ['admin', 'ws', id] as const, log: (id: string) => ['admin', 'log', id] as const };

const usageLine = (a: AdminWorkspace): string => {
  const u = a.usage;
  return [
    plural('admin.nMembers', u?.members ?? 0),
    plural('admin.nRooms', u?.rooms ?? 0),
    ...(u?.bots ? [plural('admin.nBots', u.bots)] : []),
    ...(u?.stickerPacks ? [plural('admin.nPacks', u.stickerPacks)] : []),
    fmt.size(u?.storageBytes ?? 0n),
  ].join(' · ');
};

const activityLine = (a: AdminWorkspace): string =>
  a.usage?.lastActivity ? t('admin.activity', { when: fmt.relative(timestampDate(a.usage.lastActivity)) }) : t('admin.noActivity');

/** One workspace in the list: name + plan pill, owner, usage, last activity (a card, docs/08). */
function WorkspaceCard({ a, selected, onSelect }: { a: AdminWorkspace; selected: boolean; onSelect: () => void }): ReactNode {
  const ws = a.workspace;
  if (!ws) return null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      data-testid="admin-workspace"
      className={cx(
        'flex w-full flex-col gap-0.5 rounded-[var(--radius-card)] px-3 py-2 text-left transition-colors duration-[var(--motion-fast)]',
        selected ? 'bg-accent-strong text-accent-fg' : 'hover:bg-hover',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-semibold" title={ws.name}>
          {ws.name}
        </span>
        {ws.suspension ? <SuspendedMark selected={selected} /> : null}
        {ws.plan?.expired ? <ExpiredBadge /> : null}
        <PlanPill plan={planKind(ws.plan)} className={selected ? 'ring-1 ring-white/60' : undefined} />
      </span>
      <span className={cx('truncate text-caption', selected ? 'text-accent-fg' : 'text-muted')} title={a.ownerEmail}>
        {a.owner?.displayName ? `${a.owner.displayName} · ${a.ownerEmail}` : a.ownerEmail}
      </span>
      <span className={cx('flex min-w-0 items-center gap-2 text-caption', selected ? 'text-accent-fg' : 'text-faint')}>
        <span className="min-w-0 flex-1 truncate">{usageLine(a)}</span>
        {/* Last activity, compact («14:05», «вчера», «14 янв.»); the full text on hover. */}
        <span className="shrink-0 tabular-nums" title={activityLine(a)}>
          {a.usage?.lastActivity ? fmt.listTime(timestampDate(a.usage.lastActivity)) : '—'}
        </span>
      </span>
    </button>
  );
}

/**
 * «Администрирование» (ADR-0024, docs/08 «Администрирование»): superadmins only. A sheet like the
 * settings window — search and the list of workspaces on the left, the chosen workspace on the
 * right (summary, the plan form, the change log). The web client shows it at `/admin`.
 */
export function AdminWindow({ onClose, workspaceId }: { onClose: () => void; workspaceId?: string | undefined }): ReactNode {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), SEARCH_DEBOUNCE_MS);
  const [selected, setSelected] = useState<string | null>(workspaceId ?? null);
  const list = useQuery({
    queryKey: KEY.search(dq),
    queryFn: ({ signal }) => adminApi.search(dq, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
  // Product administration — reads included — needs a local password proof not older than
  // 5 minutes (ADR-0054, release-2.0-identity «SUPERADMIN_EMAILS … свежей local proof»). Any
  // admin request answered 403 RECENT_AUTH_REQUIRED (a list, a workspace, a save) asks for the
  // password above the pane; a confirmation refetches. The open form is kept.
  const [reauth, setReauth] = useState(false);
  useEffect(
    () =>
      onApiError((e) => {
        if (recentAuthRequired(e)) setReauth(true);
      }),
    [],
  );
  const reauthDone = useCallback(() => {
    setReauth(false);
    void qc.invalidateQueries({ queryKey: ['admin'] });
  }, [qc]);
  const notice = reauth || recentAuthRequired(list.error) ? <AdminReauth onConfirmed={reauthDone} /> : null;

  // Web: the address bar says /admin while the window is open (a reload comes back here).
  useEffect(() => {
    if (platform.kind !== 'web' || typeof history === 'undefined') return;
    try {
      if (location.pathname !== '/admin') history.replaceState(null, '', '/admin');
    } catch {
      // not fatal
    }
    return () => {
      try {
        if (location.pathname === '/admin') history.replaceState(null, '', '/');
      } catch {
        // not fatal
      }
    };
  }, []);

  const items = list.data?.workspaces ?? [];
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          aria-describedby={undefined}
          data-testid="admin-window"
          data-layout-anchor=""
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
          }}
          className="mat-sheet anim-in fixed left-1/2 top-[max(46px,calc(50vh-320px))] z-[var(--z-modal)] flex h-[min(640px,calc(100vh-62px))] w-[min(920px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-[var(--radius-panel)] focus:outline-none mobile:inset-x-0 mobile:bottom-0 mobile:top-[calc(var(--safe-top)+8px)] mobile:h-auto mobile:w-full mobile:translate-x-0 mobile:flex-col mobile:rounded-b-none mobile:rounded-t-[16px]"
        >
          <div className="mat-sheet-side flex w-[300px] shrink-0 flex-col gap-2 border-r border-line p-2 max-[1000px]:w-[280px] mobile:max-h-[45%] mobile:w-full mobile:border-b mobile:border-r-0">
            <DialogP.Title className="flex items-center gap-2 px-2 pt-2 text-body font-semibold text-fg">
              <ShieldCheck className="size-4 text-accent" aria-hidden />
              {t('admin.title')}
            </DialogP.Title>
            <label className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted" aria-hidden />
              <input
                type="search"
                role="searchbox"
                aria-label={t('admin.search')}
                placeholder={t('admin.search')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="selectable h-7 w-full min-w-0 rounded-full border border-line bg-elev pl-7 pr-3 text-body text-fg shadow-[var(--shadow-card)] placeholder:text-muted mobile:h-10 [&::-webkit-search-cancel-button]:hidden"
              />
            </label>
            <div role="listbox" aria-label={t('admin.title')} className="-mx-0.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-0.5 pb-1" data-testid="admin-list">
              {list.isLoading ? <Spinner className="mx-auto mt-6" /> : null}
              {list.isError && !recentAuthRequired(list.error) ? <p className="px-2 py-3 text-body text-danger-text">{t('admin.loadFailed')}</p> : null}
              {list.isSuccess && items.length === 0 ? <p className="px-2 py-3 text-body text-muted">{t('admin.none')}</p> : null}
              {items.map((a) =>
                a.workspace ? <WorkspaceCard key={a.workspace.id} a={a} selected={a.workspace.id === selected} onSelect={() => setSelected(a.workspace?.id ?? null)} /> : null,
              )}
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-sheet-pane)]">
            {selected ? (
              <AdminDetail key={selected} id={selected} onClose={onClose} notice={notice} />
            ) : (
              <>
                <PaneHeader title={t('admin.title')} onClose={onClose} />
                {notice}
                <div className="grid flex-1 place-items-center">{notice ? null : <Empty>{t('admin.pick')}</Empty>}</div>
              </>
            )}
          </div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/** The password confirmation the admin API asks for (RECENT_AUTH_REQUIRED), under the pane header. */
function AdminReauth({ onConfirmed }: { onConfirmed: () => void }): ReactNode {
  return (
    <div className="shrink-0 border-b border-line px-6 py-4 mobile:px-4" data-testid="admin-reauth">
      <div className="mx-auto flex max-w-[640px] flex-col gap-2">
        <p className="text-body text-muted">{t('identity.adminReauth')}</p>
        <LocalReauth open onConfirmed={onConfirmed} />
      </div>
    </div>
  );
}

function PaneHeader({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }): ReactNode {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line pl-6 pr-3 mobile:pl-4">
      <h2 className="flex min-w-0 items-center gap-2 text-headline font-semibold">
        <span className="truncate">{title}</span>
        {children}
      </h2>
      <CloseButton label={t('settings.close')} onClick={onClose} />
    </div>
  );
}

const STREAM_PRESETS = [ScreenSharePreset.UNSPECIFIED, ScreenSharePreset.ECONOMY, ScreenSharePreset.H720, ScreenSharePreset.H1080, ScreenSharePreset.ORIGINAL];
const CAMERA_PRESET_OPTIONS = [ScreenSharePreset.UNSPECIFIED, ScreenSharePreset.H720, ScreenSharePreset.H1080];
const PRESET_NAME: Record<ScreenSharePreset, MessageKey> = {
  [ScreenSharePreset.UNSPECIFIED]: 'plan.unlimited',
  [ScreenSharePreset.ECONOMY]: 'preset.economy',
  [ScreenSharePreset.H720]: 'preset.h720',
  [ScreenSharePreset.H1080]: 'preset.h1080',
  [ScreenSharePreset.ORIGINAL]: 'preset.original',
};

const FIELD_LABEL: Record<LimitsField, MessageKey> = {
 boardFormsPerBoard: 'forms.limit',
  roomMembers: 'plan.limit.roomMembers',
  members: 'plan.limit.members',
  streamsPerRoom: 'plan.limit.streams',
  streamMaxFps: 'admin.limit.streamFps',
  cameraMaxFps: 'admin.limit.cameraFps',
  storageMb: 'admin.limit.storageMb',
  bots: 'plan.limit.bots',
  stickerPacks: 'plan.limit.stickerPacks',
};

function formFrom(a: AdminWorkspace): PlanForm {
  const p = a.workspace?.plan;
  const kind = planKind(p);
  return {
    plan: kind === Plan.TEAM || kind === Plan.ENTERPRISE || kind === Plan.CUSTOM ? kind : Plan.FREE,
    limits: limitsFormFrom(kind, p?.limits),
    validUntil: inputFromDate(p?.validUntil ? timestampDate(p.validUntil) : null),
    note: a.planNote,
  };
}

function NumberField({ field, form, onChange }: { field: LimitsField; form: LimitsForm; onChange: (f: LimitsForm) => void }): ReactNode {
  const label = t(FIELD_LABEL[field]);
  return (
    <Row label={label}>
      <Input
        aria-label={label}
        inputMode="numeric"
        className="w-28 text-right tabular-nums"
        value={form[field]}
        onChange={(e) => onChange({ ...form, [field]: e.target.value.replace(/[^\d]/g, '') })}
      />
    </Row>
  );
}

function PresetField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: ScreenSharePreset;
  options: ScreenSharePreset[];
  onChange: (p: ScreenSharePreset) => void;
}): ReactNode {
  return (
    <Row label={label}>
      <Select aria-label={label} className="w-44" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((p) => (
          <option key={p} value={p}>
            {t(PRESET_NAME[p])}
          </option>
        ))}
      </Select>
    </Row>
  );
}

/** The chosen workspace: summary, the plan form (PUT with a confirmation), the change log. */
function AdminDetail({ id, onClose, notice }: { id: string; onClose: () => void; notice: ReactNode }): ReactNode {
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: KEY.ws(id), queryFn: ({ signal }) => adminApi.get(id, signal), retry: false });
  const log = useQuery({ queryKey: KEY.log(id), queryFn: ({ signal }) => adminApi.log(id, signal), retry: false });
  const a = ws.data?.workspace;
  const [form, setForm] = useState<PlanForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The form starts from the loaded workspace (once; a save refreshes it below).
  if (a && !form) setForm(formFrom(a));

  const save = useMutation({
    mutationFn: (body: Parameters<typeof adminApi.setPlan>[1]) => adminApi.setPlan(id, body),
    onSuccess: (r) => {
      toast.success(t('admin.saved'));
      if (r.workspace) {
        qc.setQueryData(KEY.ws(id), { workspace: r.workspace });
        setForm(formFrom(r.workspace));
      }
      void qc.invalidateQueries({ queryKey: ['admin', 'search'] });
      void qc.invalidateQueries({ queryKey: KEY.log(id) });
    },
    onError: (e) => setError(errorText(e, t('err.ctx.save'))),
  });

  if (!a?.workspace || !form) {
    return (
      <>
        <PaneHeader title={t('admin.title')} onClose={onClose} />
        {notice}
        <div className="grid flex-1 place-items-center">
          {recentAuthRequired(ws.error) ? null : ws.isError ? <Empty>{errorText(ws.error)}</Empty> : <Spinner />}
        </div>
      </>
    );
  }
  const w = a.workspace;
  const submit = async (): Promise<void> => {
    setError(null);
    const r = setPlanBody(form);
    if ('error' in r) {
      setError(t('admin.invalid', { field: t(FIELD_LABEL[r.error]) }));
      return;
    }
    const ok = await confirmAction(t('admin.saveTitle'), t('admin.saveText', { name: w.name, plan: t(PLAN_LABEL[form.plan]) }), t('admin.save'), 'primary');
    if (!ok) return;
    const { validUntil, ...rest } = r.body;
    save.mutate({ ...rest, ...(validUntil ? { validUntil: timestampFromDate(validUntil) } : {}) });
  };
  const setLimits = (limits: LimitsForm): void => setForm({ ...form, limits });
  const entries = log.data?.entries ?? [];

  return (
    <>
      <PaneHeader title={w.name} onClose={onClose}>
        {w.suspension ? <SuspendedBadge /> : null}
        {w.plan?.expired ? <ExpiredBadge /> : null}
        <PlanPill plan={planKind(w.plan)} />
      </PaneHeader>
      {notice}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 mobile:px-4" data-testid="admin-detail">
        <div className="mx-auto flex max-w-[640px] flex-col gap-6">
          <Card title={t('admin.card.workspace')}>
            <Row label={t('admin.row.owner')}>
              <span className="max-w-72 truncate text-body text-muted" title={a.ownerEmail}>
                {a.owner?.displayName ? `${a.owner.displayName} · ${a.ownerEmail}` : a.ownerEmail}
              </span>
            </Row>
            <Row label={t('admin.row.slug')}>
              <code className="selectable font-mono text-caption text-muted">{w.slug}</code>
            </Row>
            <Row label={t('admin.row.created')}>
              <span className="text-body text-muted">{w.createdAt ? fmt.shortDate(timestampDate(w.createdAt)) : '—'}</span>
            </Row>
            <Row label={t('admin.row.usage')}>
              <span className="text-body text-muted">{usageLine(a)}</span>
            </Row>
            <Row label={t('admin.row.activity')}>
              <span className="text-body text-muted">{a.usage?.lastActivity ? fmt.stamp(timestampDate(a.usage.lastActivity)) : t('admin.noActivity')}</span>
            </Row>
          </Card>

          <Card title={t('admin.card.plan')} footer={a.planUpdatedAt ? t('admin.updated', { when: fmt.stamp(timestampDate(a.planUpdatedAt)) }) : undefined}>
            <Row label={t('admin.row.plan')}>
              <Segmented<'FREE' | 'TEAM' | 'ENTERPRISE' | 'CUSTOM'>
                label={t('admin.row.plan')}
                value={Plan[form.plan] as 'FREE' | 'TEAM' | 'ENTERPRISE' | 'CUSTOM'}
                onChange={(v) => setForm({ ...form, plan: Plan[v] })}
                options={[
                  { value: 'FREE', label: t('plan.name.free') },
                  { value: 'TEAM', label: t('plan.name.team') },
                  { value: 'ENTERPRISE', label: t('plan.name.enterprise') },
                  { value: 'CUSTOM', label: t('plan.name.custom') },
                ]}
              />
            </Row>
            <Row label={t('admin.row.validUntil')} hint={t('admin.validHint')}>
              <Input
                type="date"
                aria-label={t('admin.row.validUntil')}
                className="w-40 [color-scheme:inherit]"
                value={form.validUntil}
                onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
              />
            </Row>
            <Row label={t('admin.row.note')}>
              <Input
                aria-label={t('admin.row.note')}
                className="w-72"
                maxLength={NOTE_MAX}
                placeholder={t('admin.notePh')}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </Row>
          </Card>

          {form.plan === Plan.CUSTOM ? (
            <Card title={t('admin.card.limits')} footer={t('admin.limitsHint')}>
              <NumberField field="roomMembers" form={form.limits} onChange={setLimits} />
              <NumberField field="streamsPerRoom" form={form.limits} onChange={setLimits} />
              <PresetField
                label={t('admin.limit.streamPreset')}
                value={form.limits.streamMaxPreset}
                options={STREAM_PRESETS}
                onChange={(p) => setLimits({ ...form.limits, streamMaxPreset: p })}
              />
              <NumberField field="streamMaxFps" form={form.limits} onChange={setLimits} />
              <PresetField
                label={t('admin.limit.cameraPreset')}
                value={form.limits.cameraMaxPreset}
                options={CAMERA_PRESET_OPTIONS}
                onChange={(p) => setLimits({ ...form.limits, cameraMaxPreset: p })}
              />
              <NumberField field="cameraMaxFps" form={form.limits} onChange={setLimits} />
              <NumberField field="storageMb" form={form.limits} onChange={setLimits} />
              <NumberField field="members" form={form.limits} onChange={setLimits} />
              <Row label={t('admin.limit.audio')}>
                <Select
                  aria-label={t('admin.limit.audio')}
                  className="w-44"
                  value={form.limits.audioTierMaxKbps}
                  onChange={(e) => setLimits({ ...form.limits, audioTierMaxKbps: Number(e.target.value) })}
                >
                  {AUDIO_CAP_OPTIONS.map((k) => (
                    <option key={k} value={k}>
                      {k === 0 ? t('plan.unlimited') : audioTierLabel(k)}
                    </option>
                  ))}
                </Select>
              </Row>
              <NumberField field="bots" form={form.limits} onChange={setLimits} />
              <NumberField field="stickerPacks" form={form.limits} onChange={setLimits} />
              {/* ADR-0058 §5: written with the plan — without them a save would switch both on. */}
              <Row label={t('admin.limit.checklists')} hint={t('admin.limit.checklistsHint')}>
                <Toggle label={t('admin.limit.checklists')} checked={!form.limits.checklistsDisabled} onChange={(v) => setLimits({ ...form.limits, checklistsDisabled: !v })} />
              </Row>
              <Row label={t('forms.title')}>
                <Toggle label={t('forms.title')} checked={!form.limits.boardFormsDisabled} onChange={(v) => setLimits({ ...form.limits, boardFormsDisabled: !v })} />
              </Row>
              <Row label={t('forms.limit')}>
                <Input aria-label={t('forms.limit')} type="number" min={0} value={form.limits.boardFormsPerBoard} onChange={(e) => setLimits({ ...form.limits, boardFormsPerBoard: e.target.value })} />
              </Row>
              <Row label={t('admin.limit.boardWebhooks')} hint={t('admin.limit.boardWebhooksHint')}>
                <Toggle label={t('admin.limit.boardWebhooks')} checked={!form.limits.boardWebhooksDisabled} onChange={(v) => setLimits({ ...form.limits, boardWebhooksDisabled: !v })} />
              </Row>
              {/* ADR-0060: board automations (rules and Git) — Team and above; a new Custom plan has them. */}
              <Row label={t('admin.limit.automations')} hint={t('admin.limit.automationsHint')}>
                <Toggle label={t('admin.limit.automations')} checked={!form.limits.automationsDisabled} onChange={(v) => setLimits({ ...form.limits, automationsDisabled: !v })} />
              </Row>
              {/* ADR-0046 (owner, 02.10): telephony is Business only; a new Custom plan starts without it. */}
              <Row label={t('admin.limit.telephony')} hint={t('admin.limit.telephonyHint')}>
                <Toggle label={t('admin.limit.telephony')} checked={!form.limits.telephonyDisabled} onChange={(v) => setLimits({ ...form.limits, telephonyDisabled: !v })} />
              </Row>
            </Card>
          ) : null}

          <div className="-mt-3 flex items-center justify-end gap-3">
            {error ? (
              <span role="alert" className="min-w-0 flex-1 text-caption text-danger-text">
                {error}
              </span>
            ) : null}
            <Button busy={save.isPending} onClick={() => void submit()}>
              {t('admin.save')}
            </Button>
          </div>

          <PlanLog entries={entries} loading={log.isLoading} />

          <SuspensionCard a={a} onSaved={(next) => qc.setQueryData(KEY.ws(id), { workspace: next })} />
        </div>
      </div>
    </>
  );
}

/** The change log (newest first): a macOS-like table. */
function PlanLog({ entries, loading }: { entries: PlanLogEntry[]; loading: boolean }): ReactNode {
  const cols = 'grid grid-cols-[112px_minmax(0,1fr)_104px_84px_minmax(0,1fr)] gap-3';
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-1 text-caption font-semibold text-muted">{t('admin.card.log')}</h3>
      {loading ? (
        <Spinner className="mx-auto" />
      ) : entries.length === 0 ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-3 text-body text-muted">{t('admin.logEmpty')}</p>
      ) : (
        <div role="table" aria-label={t('admin.card.log')} className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body" data-testid="admin-log">
          <div role="row" className={cx(cols, 'border-b border-[var(--color-card-line)] px-3 py-1.5 text-caption font-medium text-muted')}>
            <span role="columnheader">{t('admin.col.when')}</span>
            <span role="columnheader">{t('admin.col.who')}</span>
            <span role="columnheader">{t('admin.col.plan')}</span>
            <span role="columnheader">{t('admin.col.until')}</span>
            <span role="columnheader">{t('admin.col.note')}</span>
          </div>
          {entries.map((e) => (
            <div key={e.id} role="row" className={cx(cols, 'min-h-9 items-center border-b border-[var(--color-card-line)] px-3 py-1.5 last:border-b-0')}>
              <span role="cell" className="tabular-nums text-muted">
                {e.createdAt ? fmt.dateTime(timestampDate(e.createdAt), 'short') : '—'}
              </span>
              <span role="cell" className="truncate" title={e.actorEmail}>
                {e.actorEmail || '—'}
              </span>
              <span role="cell">
                <PlanPill plan={e.plan} />
              </span>
              <span role="cell" className="tabular-nums text-muted">
                {e.validUntil ? fmt.shortDate(timestampDate(e.validUntil)) : '—'}
              </span>
              <span role="cell" className="truncate text-muted" title={e.note}>
                {e.note || '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

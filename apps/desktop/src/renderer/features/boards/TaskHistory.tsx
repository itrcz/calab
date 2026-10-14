import { create } from '@bufbuild/protobuf';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { UnfurlResponseSchema, type TaskActivity } from '@calaba/protocol';
import { ChevronDown, Cog, Paperclip } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ProfileTarget } from '../../components/ProfileTarget';
import { Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { describe, groupByDay, mergeHistory, type Chip, type FileSnap, type HistoryCtx, type HistoryDetail, type TaskRef } from '../../lib/boards/history';
import { fmt } from '../../lib/format';
import { diffText, type DiffOp } from '../../lib/textDiff';
import { ensureRules } from '../../services/automations';
import { loadHistory, openBoardLink } from '../../services/boards';
import { ruleNameOf, useAutomations } from '../../stores/automations';
import { taskMilestonesOf, useBoards } from '../../stores/boards';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { BotBadge, FormerChip } from '../people/MemberBits';
import { MemberAvatar, estimateLabel } from './menus';
import { TaskLinkCard } from './TaskLinkCard';
import { colorCss } from './visuals';

interface Page {
  items: TaskActivity[];
  cursor: string;
  hasMore: boolean;
  loading: boolean;
}

const LOADING: Page = { items: [], cursor: '', hasMore: false, loading: true };

/**
 * «История» of the task panel (ADR-0091 §2): the journal as a timeline, newest first, grouped by
 * day; a rail on the left, the actor (avatar 20, BOT, or the automation rule), the action sentence
 * with the values, the time on the right; details (a diff, a quote, ± chips, task cards) open on
 * a click. Pages of 100 with «Показать ещё»; live TASK_ACTIVITY rows (and ADR-0081 merges) come
 * from the boards store. Props are primitives and rows are memo, keyed by entry: a task update,
 * a message or a voice / presence event re-renders nothing here.
 */
export const TaskHistory = memo(function TaskHistory({ taskId, workspaceId, boardId }: { taskId: string; workspaceId: string; boardId: string }): ReactNode {
  const live = useBoards((s) => s.activity[taskId]);
  const gone = useBoards((s) => s.activityGone[taskId]);
  const [page, setPage] = useState<Page>(LOADING);
  // The parent keys this by task: a new task starts from LOADING.
  useEffect(() => {
    let alive = true;
    void loadHistory(taskId).then((p) => alive && setPage({ items: p?.items ?? [], cursor: p?.cursor ?? '', hasMore: !!p?.hasMore, loading: false }));
    return () => {
      alive = false;
    };
  }, [taskId]);
  const more = (): void => {
    if (page.loading || !page.hasMore) return;
    setPage({ ...page, loading: true });
    void loadHistory(taskId, page.cursor).then((p) =>
      setPage((now) => (p ? { items: [...now.items, ...p.items], cursor: p.cursor, hasMore: p.hasMore, loading: false } : { ...now, loading: false })),
    );
  };
  const list = useMemo(() => mergeHistory(page.items, live, gone), [page.items, live, gone]);
  const groups = useMemo(() => groupByDay(list, (a) => (a.createdAt ? timestampMs(a.createdAt) : 0)), [list]);
  const locale = useLocale();
  const now = new Date();
  return (
    <div className="flex flex-col" data-testid="task-history" data-locale={locale}>
      {groups.map((g) => (
        <section key={g.day} className="flex flex-col" aria-label={fmt.dayLabel(new Date(g.at), now)} data-testid="history-day">
          <h4 className="px-5 pb-1 pt-2 text-caption font-medium text-muted">{fmt.dayLabel(new Date(g.at), now)}</h4>
          <ol className="relative flex flex-col">
            {/* The rail: one line through the group's dots. */}
            <span className="pointer-events-none absolute bottom-3 left-[23px] top-3 w-px bg-[var(--color-separator)]" aria-hidden />
            {g.items.map((a) => (
              <HistoryRow key={a.id} a={a} workspaceId={workspaceId} boardId={boardId} />
            ))}
          </ol>
        </section>
      ))}
      {page.loading && !list.length ? (
        <div className="grid h-12 place-items-center">
          <Spinner />
        </div>
      ) : null}
      {!page.loading && !list.length ? (
        <p className="px-5 py-3 text-caption text-muted" data-testid="activity-empty">
          {t('boards.hist.empty')}
        </p>
      ) : null}
      {page.hasMore ? (
        <button type="button" onClick={more} className="mx-5 mt-1 h-7 self-start rounded-full px-2.5 text-caption text-accent-text hover:bg-hover" data-testid="history-more">
          {page.loading ? <Spinner className="size-3.5" /> : t('boards.hist.more')}
        </button>
      ) : null}
    </div>
  );
});

/** What the client knows by id, read when a row is described (not a subscription). */
function historyCtx(workspaceId: string, boardId: string): HistoryCtx {
  const s = useBoards.getState();
  const board = s.boards[boardId];
  return {
    member: (id) => memberName(workspaceId, id),
    status: (id) => board?.statuses.find((x) => x.id === id)?.name,
    label: (id) => {
      const l = board?.labels.find((x) => x.id === id);
      return l ? { name: l.name, color: l.color } : undefined;
    },
    milestone: (id) => board?.milestones.find((x) => x.id === id)?.name,
    taskMilestone: (parentId, id) => taskMilestonesOf(s, parentId).find((x) => x.id === id)?.name,
    task: (id) => {
      const x = s.tasks[id];
      return x ? { id, key: x.key, title: x.title } : undefined;
    },
    estimate: (n) => estimateLabel(n, board?.estimateScale),
  };
}

const HistoryRow = memo(function HistoryRow({ a, workspaceId, boardId }: { a: TaskActivity; workspaceId: string; boardId: string }): ReactNode {
  const locale = useLocale();
  const e = useMemo(() => describe(a, historyCtx(workspaceId, boardId)), [a, workspaceId, boardId, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState(false);
  const name = useMemberName(workspaceId, a.actorId);
  const bot = useWorkspaces((s) => (a.actorId ? (s.users[a.actorId]?.isBot ?? false) : false));
  // A change made by an automation rule (ADR-0060): no actor, «⚙ Автоматизация: имя правила».
  const rule = !a.actorId && !!a.ruleId;
  const at = new Date(e.at);
  const detail = hasDetail(e.detail) ? e.detail : null;
  const toggle = (): void => setOpen((v) => !v);
  return (
    <li className="relative flex flex-col" data-history-row data-testid="history-row" data-kind={a.kind} data-rule={rule || undefined} data-open={open || undefined}>
      <div className="flex items-start gap-2 py-1 pl-[34px] pr-3">
        <span className="absolute left-[20px] top-[11px] size-[7px] rounded-full bg-[var(--color-label-tertiary)] ring-2 ring-[var(--color-bg)]" aria-hidden />
        {rule ? (
          <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)] text-fg" aria-hidden>
            <Cog className="size-3.5" />
          </span>
        ) : (
          <ProfileTarget userId={a.actorId} name={name} workspaceId={workspaceId} tabbable className="mt-px shrink-0 rounded-full">
            <MemberAvatar workspaceId={workspaceId} userId={a.actorId} size={20} />
          </ProfileTarget>
        )}
        <p className={cx('min-w-0 flex-1 break-words text-caption leading-[22px] text-muted', detail && 'cursor-pointer')} onClick={detail ? toggle : undefined}>
          {rule ? (
            <>
              <RuleName boardId={boardId} ruleId={a.ruleId} />{' '}
            </>
          ) : (
            <>
              <ProfileTarget userId={a.actorId} name={name} workspaceId={workspaceId} className="rounded-[var(--radius-control)] text-left font-medium text-fg hover:underline">
                {name}
              </ProfileTarget>
              {bot ? <BotBadge className="ml-1 align-[1px]" /> : null}
              <FormerChip workspaceId={workspaceId} userId={a.actorId} className="ml-1 align-[1px]" />{' '}
            </>
          )}
          <span data-testid="history-text">{e.text}</span>
        </p>
        {e.at ? (
          <time className="shrink-0 pt-px text-caption leading-[22px] tabular-nums text-faint" dateTime={at.toISOString()} title={fmt.full(at)}>
            {fmt.time(at)}
          </time>
        ) : null}
        {detail ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? t('boards.hist.hide') : t('boards.hist.details')}
            className="tap-hit grid size-[22px] shrink-0 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-fg"
            data-testid="history-toggle"
          >
            <ChevronDown className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', open && 'rotate-180')} aria-hidden />
          </button>
        ) : (
          <span className="w-[22px] shrink-0" aria-hidden />
        )}
      </div>
      {open && detail ? (
        <div className="pb-2 pl-[62px] pr-5" data-testid="history-detail">
          <Detail d={detail} workspaceId={workspaceId} />
        </div>
      ) : null}
    </li>
  );
});

function hasDetail(d: HistoryDetail | null): d is HistoryDetail {
  return !!d && (!!d.diff || !!d.quote || !!d.added?.length || !!d.removed?.length || !!d.tasks?.length || !!d.note);
}

function Detail({ d, workspaceId }: { d: HistoryDetail; workspaceId: string }): ReactNode {
  return (
    <div className="flex flex-col gap-2 text-caption">
      {d.diff ? <DiffView before={d.diff.before} after={d.diff.after} diffable={d.diff.diffable} /> : null}
      {d.quote ? (
        <blockquote className="flex flex-col gap-1.5 rounded-[var(--radius-row)] border-l-[3px] border-[var(--color-separator)] bg-hover px-2.5 py-1.5" data-testid="history-quote">
          {d.quote.text ? <span className="whitespace-pre-wrap break-words text-fg">{d.quote.text}</span> : <span className="text-muted">{t('boards.hist.noText')}</span>}
          {d.quote.files.length ? (
            <span className="flex flex-wrap gap-1">
              {d.quote.files.map((f) => (
                <FileChip key={f.id} f={f} />
              ))}
            </span>
          ) : null}
        </blockquote>
      ) : null}
      {d.added?.length || d.removed?.length ? (
        <span className="flex flex-wrap gap-1" data-testid="history-chips">
          {d.added?.map((c) => <ChipView key={`+${c.id}`} c={c} sign="+" workspaceId={workspaceId} />)}
          {d.removed?.map((c) => <ChipView key={`-${c.id}`} c={c} sign="−" workspaceId={workspaceId} />)}
        </span>
      ) : null}
      {d.tasks?.map((x) => <TaskRefCard key={`${x.ref.id}${x.removed ? '-' : '+'}`} r={x.ref} removed={x.removed} />)}
      {d.note ? <p className="whitespace-pre-wrap break-words text-fg">{d.note}</p> : null}
    </div>
  );
}

const DEL = 'rounded-[3px] bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)] px-px text-danger-text line-through decoration-1';
const ADD = 'rounded-[3px] bg-[color-mix(in_srgb,var(--color-green)_10%,transparent)] px-px text-[var(--color-green-text)]';

/** A word diff (deleted struck through in red, added in green) or, too long, «Было / Стало». */
function DiffView({ before, after, diffable }: { before: string; after: string; diffable: boolean }): ReactNode {
  const ops = useMemo((): DiffOp[] | null => (diffable ? diffText(before, after) : null), [before, after, diffable]);
  if (!ops) {
    return (
      <div className="flex flex-col gap-2" data-testid="history-blocks">
        {[
          { label: t('boards.hist.before'), text: before },
          { label: t('boards.hist.after'), text: after },
        ].map((x) => (
          <div key={x.label} className="flex flex-col gap-0.5">
            <span className="font-medium text-muted">{x.label}</span>
            <p className="scrollbar-thin max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-row)] bg-hover px-2.5 py-1.5 text-fg">{x.text || '—'}</p>
          </div>
        ))}
      </div>
    );
  }
  return (
    <p className="scrollbar-thin max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-row)] bg-hover px-2.5 py-1.5 text-fg" data-testid="history-diff">
      {ops.map((o, i) => (o.op === 'eq' ? <span key={i}>{o.text}</span> : o.op === 'del' ? <del key={i} className={DEL}>{o.text}</del> : <ins key={i} className={cx(ADD, 'no-underline')}>{o.text}</ins>))}
    </p>
  );
}

function ChipView({ c, sign, workspaceId }: { c: Chip; sign: '+' | '−'; workspaceId: string }): ReactNode {
  return (
    <span
      className={cx('inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full px-2', sign === '+' ? 'bg-[color-mix(in_srgb,var(--color-green)_14%,transparent)]' : 'bg-hover')}
      data-testid="history-chip"
      data-sign={sign === '+' ? 'added' : 'removed'}
    >
      <span className={cx('font-semibold', sign === '+' ? 'text-[var(--color-green-text)]' : 'text-danger-text')} aria-hidden>
        {sign}
      </span>
      {c.kind === 'person' ? <MemberAvatar workspaceId={workspaceId} userId={c.id} size={16} /> : null}
      {c.kind === 'label' && c.color !== undefined ? <span className="size-2 shrink-0 rounded-full" style={{ background: colorCss(c.color) }} aria-hidden /> : null}
      {c.kind === 'file' ? <Paperclip className="size-3 shrink-0 text-muted" aria-hidden /> : null}
      <span className={cx('truncate', sign === '−' ? 'text-muted line-through' : 'text-fg')}>{c.label}</span>
    </span>
  );
}

function FileChip({ f }: { f: FileSnap }): ReactNode {
  return (
    <span className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full bg-[var(--color-fill)] px-2 text-fg">
      <Paperclip className="size-3 shrink-0 text-muted" aria-hidden />
      <span className="truncate">{f.name || '—'}</span>
      {f.size ? <span className="shrink-0 text-faint">{fmt.size(f.size)}</span> : null}
    </span>
  );
}

/**
 * A parent / related task: the chat's task card (live from the store when the task is loaded
 * there), else a plain card from the snapshot that opens the task by its key.
 */
function TaskRefCard({ r, removed }: { r: TaskRef; removed: boolean }): ReactNode {
  const live = useBoards((s) => s.tasks[r.id]);
  const res = useMemo(() => (live ? create(UnfurlResponseSchema, { task: live }) : null), [live]);
  return (
    <div className={cx('bubble-in flex flex-col', removed && 'opacity-60')} data-testid="history-task" data-removed={removed || undefined}>
      {removed ? <span className="text-micro font-medium uppercase text-muted">{t('boards.hist.removed')}</span> : null}
      {res ? (
        <TaskLinkCard res={res} href={`/t/${live?.key ?? r.key}`} />
      ) : (
        <button
          type="button"
          onClick={() => r.key && openBoardLink('task', r.key)}
          className="mt-1.5 flex w-full min-w-0 max-w-[400px] items-baseline gap-1.5 rounded-[var(--radius-row)] border-l-[3px] border-[var(--bubble-accent)] bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] py-1.5 pl-2 pr-2 text-left text-body hover:bg-[color-mix(in_srgb,var(--bubble-accent)_16%,transparent)]"
        >
          <span className="shrink-0 tabular-nums text-[color:var(--bubble-meta)]">{r.key}</span>
          <span className="min-w-0 truncate font-semibold text-fg">{r.title}</span>
        </button>
      )}
    </div>
  );
}

/**
 * The actor of a rule's change: «Автоматизация: <имя правила>» inline (a cog stands in the
 * avatar's place). The name comes from the board's rules (loaded on demand — readable by every
 * viewer, BOARD_RULE_UPDATE keeps it); a deleted or unknown rule — «Автоматизация».
 */
function RuleName({ boardId, ruleId }: { boardId: string; ruleId: string }): ReactNode {
  const name = useAutomations((s) => ruleNameOf(s, ruleId));
  useEffect(() => {
    if (!name) void ensureRules(boardId);
  }, [boardId, name]);
  return (
    <span className="font-medium text-fg" data-testid="activity-rule">
      {name ? t('rules.actorNamed', { name }) : t('rules.actor')}
    </span>
  );
}


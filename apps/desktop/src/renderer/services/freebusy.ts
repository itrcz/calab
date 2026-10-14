import { t } from '../i18n';
import { eventsByDay, mergeDays, restoreExternal, withMyStatus, withoutExternal } from '../lib/calendar/external';
import { chunksIn, CHUNK_MS, replaceBusy, type WorkHours } from '../lib/calendar/freebusy';
import {
  externalChanged,
  externalReadOnly,
  freebusyApi,
  type BusyInterval,
  type CalDavAccount,
  type ExternalAnswer,
  type ExternalDeleteScopeName,
  type ExternalEvent,
  type ShareLevel,
} from '../lib/calendar/freebusyApi';
import { MAX_PEOPLE } from '../lib/calendar/people';
import { log } from '../lib/log';
import { entryKey, useFreeBusy, type FbEntry } from '../stores/freebusy';
import { myUserId, useSession } from '../stores/session';
import { toast } from '../stores/toasts';

/**
 * Free / busy loading (ADR-0041 §3): people's busy time in 14-day windows, each window of a person
 * asked once (the people missing a window go in one request), asked again after a meeting of the
 * workspace changes (EVENT_*, once per burst). The store is written once per answer.
 */

const fb = (): ReturnType<typeof useFreeBusy.getState> => useFreeBusy.getState();
const chunkId = (ws: string, user: string, c: number): string => `${ws}|${user}|${c}`;

async function load(ws: string, users: readonly string[], chunk: number): Promise<void> {
  const from = chunk * CHUNK_MS;
  const to = from + CHUNK_MS;
  try {
    const list = await freebusyApi.get(ws, users, from, to);
    useFreeBusy.setState((s) => {
      const entries: Record<string, FbEntry> = { ...s.entries };
      for (const u of list) {
        const k = entryKey(ws, u.userId);
        entries[k] = { timezone: u.timezone, workHours: u.workHours, busy: replaceBusy(entries[k]?.busy ?? [], from, to, u.busy) };
      }
      return { entries, rev: s.rev + 1 };
    });
  } catch (e) {
    log.warn('freebusy: load failed', e);
    useFreeBusy.setState((s) => {
      const chunks = { ...s.chunks };
      for (const u of users) delete chunks[chunkId(ws, u, chunk)];
      return { chunks };
    });
  }
}

/** Loads the busy time of `users` over [from, to) once (the day view, the mini month, find-a-time). */
export function ensureBusy(ws: string, users: readonly string[], from: number, to: number): void {
  if (!ws || users.length === 0) return;
  const held = fb().chunks;
  const todo = new Map<number, string[]>();
  for (const c of chunksIn(from, to)) {
    const missing = users.filter((u) => u && !held[chunkId(ws, u, c)]);
    if (missing.length) todo.set(c, missing);
  }
  if (!todo.size) return;
  useFreeBusy.setState((s) => {
    const chunks = { ...s.chunks };
    for (const [c, list] of todo) for (const u of list) chunks[chunkId(ws, u, c)] = true;
    return { chunks };
  });
  for (const [c, list] of todo) for (let i = 0; i < list.length; i += MAX_PEOPLE) void load(ws, list.slice(i, i + MAX_PEOPLE), c);
}

const timers = new Map<string, number>();

/** A meeting of the workspace changed: every loaded window of it is asked again (once for a burst). */
export function invalidateBusy(ws: string, onlyUser?: string): void {
  const id = `${ws}|${onlyUser ?? ''}`;
  if (timers.has(id)) return;
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      const byChunk = new Map<number, string[]>();
      for (const k of Object.keys(fb().chunks)) {
        const [w, u = '', c] = k.split('|');
        if (w !== ws || (onlyUser && u !== onlyUser)) continue;
        const n = Number(c);
        byChunk.set(n, [...(byChunk.get(n) ?? []), u]);
      }
      for (const [c, list] of byChunk) for (let i = 0; i < list.length; i += MAX_PEOPLE) void load(ws, list.slice(i, i + MAX_PEOPLE), c);
    }, 400),
  );
}

/** My windows in every workspace (a CalDAV sync / import change). */
function invalidateMe(): void {
  const me = myUserId();
  if (!me) return;
  const spaces = new Set(Object.keys(fb().chunks).map((k) => k.split('|')[0] ?? ''));
  for (const ws of spaces) if (ws) invalidateBusy(ws, me);
}

// ---------------------------------------------------------------- selectors

/**
 * One person's busy time over [from, to) as a primitive (a component re-renders only when it
 * changes): `start~end~kind~eventId~allDay~title~attendees` joined by `|` (the title of a shared
 * external interval URI-encoded, ADR-0045 §4); '' = nothing (or not loaded).
 */
export function busySignature(e: FbEntry | undefined, from: number, to: number): string {
  if (!e) return '';
  let out = '';
  for (const b of e.busy) {
    if (b.end <= from || b.start >= to) continue;
    out += `${out ? '|' : ''}${b.start}~${b.end}~${b.kind === 'external' ? 'x' : 'm'}~${b.eventId}~${b.allDay ? 1 : 0}~${encodeTitle(b.title)}~${b.attendees.join(',')}`;
  }
  return out;
}

const encodeTitle = (t: string): string => (t ? encodeURIComponent(t).replace(/~/g, '%7E') : '');
function decodeTitle(t: string): string {
  try {
    return t ? decodeURIComponent(t) : '';
  } catch {
    return '';
  }
}

export function parseBusySignature(sig: string): BusyInterval[] {
  if (!sig) return [];
  return sig.split('|').map((p) => {
    const [s, e, k, id = '', a, title = '', att = ''] = p.split('~');
    return { start: Number(s), end: Number(e), kind: k === 'x' ? 'external' : 'meeting', eventId: id, allDay: a === '1', title: decodeTitle(title), attendees: att ? att.split(',') : [] };
  });
}

/** A person's zone and work hours as a primitive: `tz~start~end~days`. '' = not loaded. */
export function hoursSignature(e: FbEntry | undefined): string {
  return e ? `${e.timezone}~${e.workHours.startMin}~${e.workHours.endMin}~${e.workHours.days.join(',')}` : '';
}

export function parseHoursSignature(sig: string): { timezone: string; workHours: WorkHours } | null {
  if (!sig) return null;
  const [tz = 'UTC', s, e, d = ''] = sig.split('~');
  return { timezone: tz, workHours: { startMin: Number(s), endMin: Number(e), days: d ? d.split(',').map(Number) : [] } };
}

// ---------------------------------------------------------------- work hours, CalDAV

/** PATCH /api/me work_hours; the saved Me goes to the session (Me.settings.work_hours), my busy windows are asked again. */
export async function saveMyWorkHours(wh: WorkHours): Promise<boolean> {
  try {
    const r = await freebusyApi.saveWorkHours(wh);
    if (r.me) useSession.getState().set({ me: r.me });
    invalidateMe();
    return true;
  } catch (e) {
    toast.fail(e, t('err.ctx.save'));
    return false;
  }
}

export async function loadCalDav(): Promise<void> {
  try {
    const { account, planLocked } = await freebusyApi.caldav.get();
    useFreeBusy.setState({ caldav: account, caldavLocked: planLocked });
  } catch (e) {
    log.warn('caldav: get failed', e);
    useFreeBusy.setState({ caldav: null, caldavLocked: false });
  }
}

/** The account's new state (a connect, a change, a sync); my busy windows and external events are asked again. */
export function setCalDav(account: CalDavAccount | null): void {
  useFreeBusy.setState({ caldav: account, caldavLocked: false, external: {}, externalWs: '', externalChunks: {} });
  invalidateMe();
}

/** PATCH share_level (ADR-0045 §2): shown at once, back on a failure. */
export async function setShareLevel(level: ShareLevel): Promise<void> {
  const before = fb().caldav;
  if (!before || before.shareLevel === level) return;
  useFreeBusy.setState({ caldav: { ...before, shareLevel: level } });
  try {
    const account = await freebusyApi.caldav.setShare(level);
    if (account) useFreeBusy.setState({ caldav: account });
  } catch (e) {
    useFreeBusy.setState((s) => (s.caldav ? { caldav: { ...s.caldav, shareLevel: before.shareLevel } } : s));
    toast.fail(e, t('err.ctx.save'));
  }
}

/** «Напоминать о внешних встречах» (ADR-0045 amendment 3), optimistic like the share level. */
export async function setExternalReminders(remind: boolean): Promise<void> {
  const before = fb().caldav;
  if (!before || before.remind === remind) return;
  useFreeBusy.setState({ caldav: { ...before, remind } });
  try {
    const account = await freebusyApi.caldav.setRemind(remind);
    if (account) useFreeBusy.setState({ caldav: account });
  } catch (e) {
    useFreeBusy.setState((s) => (s.caldav ? { caldav: { ...s.caldav, remind: before.remind } } : s));
    toast.fail(e, t('err.ctx.save'));
  }
}

// ---------------------------------------------------------------- my external events (ADR-0045 §3)

/**
 * Loads my external events of [from, to) with the attendees matched to `ws`'s members, each 14-day
 * window once; another workspace starts over (its members differ). Only with an importing account.
 */
export function ensureExternal(ws: string, from: number, to: number): void {
  const s = fb();
  if (!ws || !s.caldav?.calendarHref || !s.caldav.import || s.caldavLocked) return;
  const held = s.externalWs === ws ? s.externalChunks : {};
  const todo = chunksIn(from, to).filter((c) => !held[c]);
  if (!todo.length) return;
  useFreeBusy.setState((st) => {
    const same = st.externalWs === ws;
    const chunks: Record<number, true> = same ? { ...st.externalChunks } : {};
    for (const c of todo) chunks[c] = true;
    return same ? { externalChunks: chunks } : { external: {}, externalWs: ws, externalChunks: chunks };
  });
  for (const c of todo) void loadExternal(ws, c);
}

async function loadExternal(ws: string, chunk: number): Promise<void> {
  const from = chunk * CHUNK_MS;
  const to = from + CHUNK_MS;
  try {
    const list = await freebusyApi.externalEvents(ws, from, to);
    useFreeBusy.setState((s) => (s.externalWs === ws && s.externalChunks[chunk] ? { external: mergeDays(s.external, eventsByDay(list, from, to), from, to) } : s));
  } catch (e) {
    log.warn('freebusy: external events failed', e);
    useFreeBusy.setState((s) => {
      if (s.externalWs !== ws) return s;
      const externalChunks = { ...s.externalChunks };
      delete externalChunks[chunk];
      return { externalChunks };
    });
  }
}

/**
 * «Удалить из календаря» (ADR-0045 amendment 1): the event (a series, or one without repeats —
 * every occurrence; else this occurrence) leaves my day at once and comes back if the server
 * refuses: 409 — it changed in the calendar (the server imported it again: my events are asked
 * anew), 422 — the calendar is read-only. My busy windows are asked again after a success.
 */
export async function deleteExternalEvent(ev: ExternalEvent, scope: ExternalDeleteScopeName): Promise<boolean> {
  const whole = scope === 'series' || !ev.recurring;
  const ws = fb().externalWs;
  const { days, removed } = withoutExternal(fb().external, ev, whole);
  useFreeBusy.setState({ external: days });
  try {
    await freebusyApi.deleteExternal(ev, whole ? 'series' : 'this');
    invalidateMe();
    return true;
  } catch (e) {
    useFreeBusy.setState((s) => (s.externalWs === ws ? { external: restoreExternal(s.external, removed) } : s));
    if (externalChanged(e)) {
      toast.error(t('ext.deleteChanged'));
      // Imported again by the server: the shown days ask for my events anew (the held ones stay
      // until the answer replaces them), my busy windows too.
      useFreeBusy.setState((s) => (s.externalWs === ws ? { externalChunks: {} } : s));
      invalidateMe();
    } else if (externalReadOnly(e)) toast.error(t('ext.deleteReadOnly'));
    else toast.fail(e, t('ext.deleteFailed'));
    return false;
  }
}

/**
 * «Приму / Отклоню / Может быть» of my external event (ADR-0045 amendment 2): the answer shows on
 * every occurrence at once and goes back if the server refuses (409 — it changed in the calendar,
 * 422 — read-only); after a success my events are asked anew (the server imported them again).
 */
export async function respondExternalEvent(ev: ExternalEvent, status: ExternalAnswer): Promise<boolean> {
  const ws = fb().externalWs;
  const before = ev.myStatus;
  useFreeBusy.setState((s) => (s.externalWs === ws ? { external: withMyStatus(s.external, ev.uid, status) } : s));
  try {
    await freebusyApi.respondExternal(ev, status);
    useFreeBusy.setState((s) => (s.externalWs === ws ? { externalChunks: {} } : s));
    return true;
  } catch (e) {
    useFreeBusy.setState((s) => (s.externalWs === ws ? { external: withMyStatus(s.external, ev.uid, before) } : s));
    if (externalChanged(e)) {
      toast.error(t('ext.rsvpChanged'));
      useFreeBusy.setState((s) => (s.externalWs === ws ? { externalChunks: {} } : s));
    } else if (externalReadOnly(e)) toast.error(t('ext.rsvpReadOnly'));
    else toast.fail(e, t('cal.rsvp.failed'));
    return false;
  }
}

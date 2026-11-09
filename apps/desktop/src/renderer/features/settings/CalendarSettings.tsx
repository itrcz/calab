import { ArrowUp, ChevronRight, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { PlanLock } from '../../components/PlanLock';
import { PickerPopover } from '../../components/picker/Picker';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { useSettingsNav } from '../../components/SettingsWindow';
import { Button, Card, Field, IconButton, Input, PasswordInput, Row, Segmented, Select, Spinner, Toggle, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import type { WorkHours } from '../../lib/calendar/freebusy';
import { freebusyApi, workHoursOf, type CalDavAccount, type ShareLevel } from '../../lib/calendar/freebusyApi';
import { formatMinutes, viewerZone, useWeekStart } from '../../lib/calendar/time';
import { MAX_EXTRA_ZONES, ZONE_LABEL_MAX, moveUp, parseZonesSig, zoneCity, zoneOffsetLabel, zoneOptions, zoneTime, zonesSig, type ExtraZone, type ZoneOption } from '../../lib/calendar/zones';
import { WORK_ENDS, WORK_STARTS, toggleWeekday, validateWorkHours, weekdayOrder, withStart } from '../../lib/calendar/workHours';
import { dateTimeFormat } from '../../lib/format';
import { refetchLoadedMonths } from '../../services/calendar';
import { usePrefs } from '../../stores/prefs';
import { loadCalDav, saveCalendarZones, saveMyWorkHours, setCalDav, setExternalReminders, setShareLevel } from '../../services/freebusy';
import { useFreeBusy } from '../../stores/freebusy';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';

/**
 * Settings → Календарь (ADR-0041 §1, §4): my work hours (what «Подобрать время» shows to others),
 * a link to the meeting reminders (they stay in «Уведомления»), and one external CalDAV calendar —
 * connect, pick the calendar, import busy time / send my meetings, what colleagues see of it
 * (ADR-0045 §2), reminders of its events (amendment 3), sync now, disconnect.
 */
export function CalendarTab(): ReactNode {
  return (
    <>
      <WeekStartCard />
      <WorkHoursCard />
      <ZonesCard />
      <RemindersLink />
      <CalDavCard />
    </>
  );
}

/** «Первый день недели» (CBF-165): a device preference, every week grid and picker follows it. */
function WeekStartCard(): ReactNode {
  const first = useWeekStart();
  const setPrefs = usePrefs((s) => s.setPrefs);
  return (
    <Card>
      <Row label={t('fb.week.first')} hint={t('fb.week.firstHint')}>
        <Segmented<'1' | '0'>
          label={t('fb.week.first')}
          value={first === 0 ? '0' : '1'}
          onChange={(v) => {
            setPrefs({ weekStartsOn: v === '0' ? 0 : 1 });
            refetchLoadedMonths();
          }}
          options={[
            { value: '1', label: t('fb.week.mon') },
            { value: '0', label: t('fb.week.sun') },
          ]}
        />
      </Row>
    </Card>
  );
}

function WorkHoursCard(): ReactNode {
  const first = useWeekStart();
  // Me.settings.work_hours (the default until set); a change shows at once, the saved Me follows.
  const stored = useSession((s) => s.me?.settings?.workHours);
  const saved = useMemo(() => workHoursOf(stored), [stored]);
  const [draft, setDraft] = useState<WorkHours | null>(null);
  const wh = draft ?? saved;
  const error = validateWorkHours(wh);
  const change = (next: WorkHours): void => {
    setDraft(next);
    if (validateWorkHours(next)) return;
    void saveMyWorkHours(next).then(() => setDraft(null));
  };
  const names = dateTimeFormat({ weekday: 'short' });
  return (
    <Card title={t('fb.wh.title')} footer={t('fb.wh.hint', { zone: viewerZone() })}>
      <Row label={t('fb.wh.start')}>
        <Select value={wh.startMin} onChange={(e) => change(withStart(wh, Number(e.target.value)))} aria-label={t('fb.wh.start')} data-testid="wh-start">
          {WORK_STARTS.map((m) => (
            <option key={m} value={m}>
              {formatMinutes(m)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('fb.wh.end')}>
        <Select value={wh.endMin} onChange={(e) => change({ ...wh, endMin: Number(e.target.value) })} aria-label={t('fb.wh.end')} data-testid="wh-end">
          {WORK_ENDS.map((m) => (
            <option key={m} value={m}>
              {m === 1440 ? '24:00' : formatMinutes(m)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('fb.wh.days')} hint={error ? <span className="text-danger-text">{t(error)}</span> : undefined}>
        <div role="group" aria-label={t('fb.wh.days')} className="flex flex-wrap justify-end gap-1" data-testid="wh-days">
          {weekdayOrder(first).map((d) => {
            const on = wh.days.includes(d);
            // 2026-01-05 is a Monday: ISO day d → 4 + d.
            const label = names.format(new Date(2026, 0, 4 + d));
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
               
                onClick={() => change({ ...wh, days: toggleWeekday(wh.days, d) })}
                className={cx(
                  'h-7 min-w-9 rounded-full px-2 text-control font-medium transition-colors duration-[var(--motion-fast)] disabled:opacity-40',
                  on ? 'bg-accent-strong text-accent-fg' : 'bg-[var(--color-fill)] text-fg hover:bg-[var(--color-fill-hover)]',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </Row>
    </Card>
  );
}

// ---------------------------------------------------------------- extra time zones (board #85)

type ZoneItem = ZoneOption;

/**
 * «Дополнительные часовые пояса»: up to two zones shown as muted hour columns next to the main
 * scale (day and week views). Each row: the zone's label (or city), its offset and wall time now,
 * an optional label, ↑ and ×; «Добавить часовой пояс» opens the one list picker over the IANA
 * zones (search by city, zone name, localized name or offset). Saved to Me at once.
 */
function ZonesCard(): ReactNode {
  const locale = useLocale();
  const sig = useSession((s) => zonesSig(s.me?.settings?.calendarZones));
  const zones = useMemo(() => parseZonesSig(sig), [sig]);
  const [open, setOpen] = useState(false);
  // The «now» of the rows: when the page opened (a settings page, no clock ticking).
  const [now] = useState(Date.now);
  // Built when the picker first opens (≈ 420 zones × Intl), not with the settings page.
  const options = useMemo(() => (open ? zoneOptions(locale) : []), [open, locale]);
  const groups = useMemo<PickerGroup<ZoneItem>[]>(
    () => [{ id: 'zones', label: '', items: options.filter((o) => !zones.some((z) => z.zone === o.id)) }],
    [options, zones],
  );
  const save = (next: readonly ExtraZone[]): void => void saveCalendarZones(next);
  const onSelect = useCallback(
    (item: ZoneItem) => {
      setOpen(false);
      void saveCalendarZones([...zones, { zone: item.id, label: '' }]);
    },
    [zones],
  );
  const renderItem = useCallback(
    (item: ZoneItem, active: boolean) => (
      <>
        <span className="min-w-0 flex-1 truncate">
          {item.city}
          {item.name && item.name !== item.city ? <span className={cx('ml-1.5', active ? null : 'text-muted')}>{item.name}</span> : null}
        </span>
        <span className={cx('shrink-0 text-caption tabular-nums', active ? null : 'text-muted')}>
          {item.offsetLabel} · {zoneTime(now, item.id, locale)}
        </span>
      </>
    ),
    [locale, now],
  );
  const main = viewerZone();
  return (
    <Card title={t('fb.tz.title')} footer={t('fb.tz.hint')}>
      <Row label={t('fb.tz.main')} hint={t('fb.tz.mainHint', { zone: main })}>
        <span className="text-caption tabular-nums text-muted">{t('fb.tz.now', { offset: zoneOffsetLabel(main, now), time: zoneTime(now, main, locale) })}</span>
      </Row>
      {zones.map((z, i) => (
        <ZoneRow key={z.zone} zone={z} first={i === 0} now={now} onLabel={(label) => save(zones.map((x, j) => (j === i ? { ...x, label } : x)))} onUp={() => save(moveUp(zones, i))} onRemove={() => save(zones.filter((_, j) => j !== i))} />
      ))}
      {zones.length < MAX_EXTRA_ZONES ? (
        <div className="px-3 py-2">
          <PickerPopover
            groups={groups}
            renderItem={renderItem}
            onSelect={onSelect}
            placeholder={t('fb.tz.search')}
            label={t('fb.tz.list')}
            emptyText={t('fb.tz.empty')}
            open={open}
            onOpenChange={setOpen}
            width={380}
            testId="cal-zone-list"
          >
            <Button variant="ghost" size="sm" data-testid="cal-zone-add">
              <Plus className="size-3.5" aria-hidden />
              {t('fb.tz.add')}
            </Button>
          </PickerPopover>
        </div>
      ) : null}
    </Card>
  );
}

function ZoneRow({ zone, first, now, onLabel, onUp, onRemove }: { zone: ExtraZone; first: boolean; now: number; onLabel: (label: string) => void; onUp: () => void; onRemove: () => void }): ReactNode {
  const locale = useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? zone.label;
  const city = zoneCity(zone.zone);
  const commit = (): void => {
    if (draft !== null && draft.trim() !== zone.label) onLabel(draft.trim());
    setDraft(null);
  };
  return (
    <Row label={zone.label || city} hint={`${zone.zone} · ${t('fb.tz.now', { offset: zoneOffsetLabel(zone.zone, now), time: zoneTime(now, zone.zone, locale) })}`}>
      <Input
        value={value}
        onChange={(e) => setDraft(e.target.value.slice(0, ZONE_LABEL_MAX))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        placeholder={city}
        maxLength={ZONE_LABEL_MAX}
        aria-label={t('fb.tz.labelOf', { zone: city })}
        className="w-32"
        data-testid="cal-zone-label"
      />
      {first ? null : (
        <IconButton label={t('fb.tz.up', { zone: zone.label || city })} size="sm" onClick={onUp} data-testid="cal-zone-up">
          <ArrowUp className="size-4" aria-hidden />
        </IconButton>
      )}
      <IconButton label={t('fb.tz.remove', { zone: zone.label || city })} size="sm" onClick={onRemove} data-testid="cal-zone-remove">
        <X className="size-4" aria-hidden />
      </IconButton>
    </Row>
  );
}

function RemindersLink(): ReactNode {
  const nav = useSettingsNav();
  if (!nav) return null;
  return (
    <Card>
      <Row label={t('cal.remindersTitle')} hint={t('fb.remindersWhere')}>
        <Button variant="ghost" size="sm" onClick={() => nav('notifications')} data-testid="cal-reminders-link">
          {t('fb.open')}
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      </Row>
    </Card>
  );
}

// ---------------------------------------------------------------- CalDAV

function CalDavCard(): ReactNode {
  const account = useFreeBusy((s) => s.caldav);
  const locked = useFreeBusy((s) => s.caldavLocked);
  useEffect(() => {
    void loadCalDav();
  }, []);
  return (
    <Card title={t('fb.dav.title')} footer={t('fb.dav.google')}>
      {account === undefined ? (
        <div className="grid h-16 place-items-center">
          <Spinner />
        </div>
      ) : locked ? (
        <CalDavLocked account={account} />
      ) : account ? (
        <CalDavConnected account={account} />
      ) : (
        <CalDavConnect />
      )}
    </Card>
  );
}

/** No plan of mine includes CalDAV (Free): the form stays visible under a lock (PlanLock); a stored account is kept, not shown as working. */
function CalDavLocked({ account }: { account: CalDavAccount | null }): ReactNode {
  return (
    <>
      {account ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3" data-testid="caldav-locked">
          <span className="text-caption text-faint">{t('fb.dav.lockedStopped', { host: hostOf(account.url) })}</span>
          <Button variant="destructive" size="sm" onClick={() => void freebusyApi.caldav.remove().then(() => setCalDav(null))} data-testid="caldav-disconnect">
            {t('fb.dav.disconnect')}
          </Button>
        </div>
      ) : null}
      <PlanLock plan="team" testId="caldav-locked-lock">
        <CalDavConnect />
      </PlanLock>
    </>
  );
}

function CalDavConnect(): ReactNode {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const connect = async (): Promise<void> => {
    const u = url.trim();
    if (!/^https:\/\/\S+$/i.test(u)) {
      setError(t('fb.dav.errUrl'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const account = await freebusyApi.caldav.connect(u, username.trim(), password);
      setPassword('');
      setCalDav(account);
      toast.success(t('fb.dav.connected'));
    } catch (e) {
      setError(errorText(e, t('fb.dav.errConnect')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
      data-testid="caldav-connect"
      aria-describedby={`${id}-hint`}
    >
      <p id={`${id}-hint`} className="text-caption text-muted">
        {t('fb.dav.intro')}
      </p>
      <Field label={t('fb.dav.url')} hint={t('fb.dav.urlHint')}>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://caldav.icloud.com" inputMode="url" autoComplete="url" data-testid="caldav-url" />
      </Field>
      <Field label={t('fb.dav.login')}>
        <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" data-testid="caldav-login" />
      </Field>
      <Field label={t('fb.dav.password')} hint={t('fb.dav.passwordHint')}>
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-testid="caldav-password" />
      </Field>
      {error ? (
        <p role="alert" className="text-caption text-danger-text">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" busy={busy} disabled={!url.trim() || !username.trim() || !password} data-testid="caldav-submit">
          {t('fb.dav.connect')}
        </Button>
      </div>
    </form>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const SHARE_HINT: Record<ShareLevel, 'fb.dav.shareBusyHint' | 'fb.dav.shareTitleHint' | 'fb.dav.shareDetailsHint'> = {
  busy: 'fb.dav.shareBusyHint',
  title: 'fb.dav.shareTitleHint',
  details: 'fb.dav.shareDetailsHint',
};

/** «Что видят коллеги» (ADR-0045 §2): a segmented control over the whole row, its one-line hint below. */
function ShareRow({ level, disabled }: { level: ShareLevel; disabled: boolean }): ReactNode {
  return (
    <div className={cx('flex flex-col items-start gap-2 px-3 py-2.5', disabled && 'pointer-events-none opacity-50')} data-settings-row data-testid="caldav-share" aria-disabled={disabled || undefined}>
      <span className="text-body" data-settings-label data-settings-hint={t('fb.dav.shareHint')}>
        {t('fb.dav.share')}
      </span>
      <Segmented<ShareLevel>
        label={t('fb.dav.share')}
        value={level}
        onChange={(v) => void setShareLevel(v)}
        options={[
          { value: 'busy', label: t('fb.dav.shareBusy') },
          { value: 'title', label: t('fb.dav.shareTitle') },
          { value: 'details', label: t('fb.dav.shareDetails') },
        ]}
      />
      <span className="text-caption text-faint">{t(SHARE_HINT[level])}</span>
    </div>
  );
}

function CalDavConnected({ account }: { account: CalDavAccount }): ReactNode {
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const guest = useSession((s) => s.me?.user?.isGuest === true);
  if (guest) return null;
  const picked = !!account.calendarHref;

  const update = async (patch: Partial<Pick<CalDavAccount, 'calendarHref' | 'import' | 'push'>>): Promise<void> => {
    const next = { calendarHref: account.calendarHref, import: account.import, push: account.push, ...patch };
    // A calendar just picked: import on by default (the point of connecting).
    if (patch.calendarHref && !account.calendarHref && patch.import === undefined) next.import = true;
    setSaving(true);
    try {
      setCalDav(await freebusyApi.caldav.update(next));
    } catch (e) {
      toast.fail(e, t('err.ctx.save'));
    } finally {
      setSaving(false);
    }
  };
  const sync = async (): Promise<void> => {
    setSyncing(true);
    try {
      setCalDav(await freebusyApi.caldav.sync());
    } catch (e) {
      toast.fail(e, t('fb.dav.errSync'));
    } finally {
      setSyncing(false);
    }
  };
  const disconnect = async (): Promise<void> => {
    if (!(await confirmAction(t('fb.dav.disconnectTitle'), t('fb.dav.disconnectText'), t('fb.dav.disconnect')))) return;
    try {
      await freebusyApi.caldav.remove();
      setCalDav(null);
    } catch (e) {
      toast.fail(e, t('err.ctx.save'));
    }
  };
  const last = account.lastSyncAt ? dateTimeFormat({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(account.lastSyncAt) : null;

  return (
    <div data-testid="caldav-account">
      {account.lastError ? (
        <div role="alert" className="m-3 flex items-start gap-2 rounded-[var(--radius-card)] bg-[var(--color-danger-fill)] px-3 py-2 text-caption text-danger-text" data-testid="caldav-error">
          <TriangleAlert className="mt-px size-4 shrink-0" aria-hidden />
          <span>{t('fb.dav.lastError', { error: account.lastError })}</span>
        </div>
      ) : null}
      <Row label={t('fb.dav.account')} hint={`${account.username} · ${hostOf(account.url)}`}>
        <Button variant="destructive" size="sm" onClick={() => void disconnect()} data-testid="caldav-disconnect">
          {t('fb.dav.disconnect')}
        </Button>
      </Row>
      <Row label={t('fb.dav.calendar')} hint={picked ? undefined : t('fb.dav.pickHint')}>
        <Select value={account.calendarHref} onChange={(e) => void update({ calendarHref: e.target.value })} disabled={saving} aria-label={t('fb.dav.calendar')} data-testid="caldav-calendar" className="max-w-56">
          {picked ? null : <option value="">{t('fb.dav.pick')}</option>}
          {account.calendars.map((c) => (
            <option key={c.href} value={c.href}>
              {c.name || c.href}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('fb.dav.import')} hint={t('fb.dav.importHint')}>
        <Toggle label={t('fb.dav.import')} checked={account.import} disabled={!picked || saving} onChange={(v) => void update({ import: v })} />
      </Row>
      <ShareRow level={account.shareLevel} disabled={!picked || !account.import} />
      <Row label={t('fb.dav.remind')} hint={t('fb.dav.remindHint')}>
        <Toggle label={t('fb.dav.remind')} checked={account.remind} disabled={!picked || !account.import} onChange={(v) => void setExternalReminders(v)} />
      </Row>
      <Row label={t('fb.dav.push')} hint={t('fb.dav.pushHint')}>
        <Toggle label={t('fb.dav.push')} checked={account.push} disabled={!picked || saving} onChange={(v) => void update({ push: v })} />
      </Row>
      <Row label={t('fb.dav.sync')} hint={last ? t('fb.dav.lastSync', { when: last }) : t('fb.dav.never')}>
        <Button variant="secondary" size="sm" busy={syncing} disabled={!picked} onClick={() => void sync()} data-testid="caldav-sync">
          <RefreshCw className="size-3.5" aria-hidden />
          {t('fb.dav.syncNow')}
        </Button>
      </Row>
    </div>
  );
}

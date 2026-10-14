import { ChevronRight, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { PlanLock } from '../../components/PlanLock';
import { useSettingsNav } from '../../components/SettingsWindow';
import { Button, Card, Field, Input, PasswordInput, Row, Segmented, Select, Spinner, Toggle, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import type { WorkHours } from '../../lib/calendar/freebusy';
import { freebusyApi, workHoursOf, type CalDavAccount, type ShareLevel } from '../../lib/calendar/freebusyApi';
import { formatMinutes, viewerZone, weekStart } from '../../lib/calendar/time';
import { WORK_ENDS, WORK_STARTS, toggleWeekday, validateWorkHours, weekdayOrder, withStart } from '../../lib/calendar/workHours';
import { dateTimeFormat } from '../../lib/format';
import { loadCalDav, saveMyWorkHours, setCalDav, setExternalReminders, setShareLevel } from '../../services/freebusy';
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
      <WorkHoursCard />
      <RemindersLink />
      <CalDavCard />
    </>
  );
}

function WorkHoursCard(): ReactNode {
  const locale = useLocale();
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
          {weekdayOrder(weekStart(locale)).map((d) => {
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

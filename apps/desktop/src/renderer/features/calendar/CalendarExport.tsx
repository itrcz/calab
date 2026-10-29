import * as Dropdown from '../../components/radix/dropdown-menu';
import { CalendarDays, Download, Ellipsis } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WorkspaceRole, type CalendarSubscription } from '@calaba/protocol';
import { confirmAction } from '../../components/Confirm';
import { Button, Field, IconButton, Input, Modal } from '../../components/ui';
import { t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { ApiError } from '../../lib/api/client';
import { calendarSubscription, downloadCalendar, exportRange, revokeCalendarSubscription } from '../../lib/calendar/subscriptionApi';
import { addDays } from '../../lib/calendar/time';
import { isWeb, platform } from '../../platform';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem } from '../shell/menu';
import { useToday } from './MiniCalendar';

export type CalendarExportMode = 'download' | 'subscription';
const subscriptionError = (e: unknown): string =>
  e instanceof ApiError && e.reason === 'CALENDAR_SUBSCRIPTION_SSO' ? t('cal.export.sso') : errorText(e, t('cal.export.failed'));

export function CalendarExportItems({ onSelect }: { onSelect: (mode: CalendarExportMode) => void }): ReactNode {
  return (
    <>
      <Dropdown.Item className={menuItem} onSelect={() => onSelect('download')} data-testid="calendar-download">
        <Download className="size-4" aria-hidden />
        {t('cal.export.download')}
      </Dropdown.Item>
      <Dropdown.Item className={menuItem} onSelect={() => onSelect('subscription')} data-testid="calendar-subscribe">
        <CalendarDays className="size-4" aria-hidden />
        {t('cal.export.subscribe')}
      </Dropdown.Item>
    </>
  );
}

export function CalendarExportControl({ workspaceId }: { workspaceId: string }): ReactNode {
  const [mode, setMode] = useState<CalendarExportMode | null>(null);
  const guest = useWorkspaces((s) => !s.byId[workspaceId] || s.byId[workspaceId].role === WorkspaceRole.GUEST);
  if (guest) return null;
  return (
    <>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <IconButton label={t('cal.export.menu')} data-testid="calendar-more">
            <Ellipsis className="size-[18px]" />
          </IconButton>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={menuBox} align="end" sideOffset={4}>
            <CalendarExportItems onSelect={setMode} />
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {mode ? <CalendarExportDialog key={`${workspaceId}:${mode}`} workspaceId={workspaceId} mode={mode} onClose={() => setMode(null)} /> : null}
    </>
  );
}

export function CalendarExportDialog({ workspaceId, mode, onClose }: { workspaceId: string; mode: CalendarExportMode; onClose: () => void }): ReactNode {
  return mode === 'download' ? (
    <DownloadDialog workspaceId={workspaceId} onClose={onClose} />
  ) : (
    <SubscriptionDialog workspaceId={workspaceId} onClose={onClose} />
  );
}

function DownloadDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  const today = useToday();
  const [from, setFrom] = useState(addDays(today, -30));
  const [through, setThrough] = useState(addDays(today, 365));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const range = exportRange(from, through);
  const save = async (): Promise<void> => {
    if (!range || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      await downloadCalendar(workspaceId, range, controller.signal);
      if (!controller.signal.aborted) onClose();
    } catch (e) {
      if (!controller.signal.aborted) setError(subscriptionError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('cal.export.download')}
      description={t('cal.export.downloadHint')}
      initialFocus="body"
      footer={
        <Button busy={busy} disabled={!range} onClick={() => void save()} data-testid="calendar-save">
          {t('cal.export.download')}
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('cal.export.from')}>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t('cal.export.through')}>
          <Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
        </Field>
      </div>
      <p className="mt-3 text-caption text-muted">{t('cal.export.series')}</p>
      {!range ? (
        <p role="alert" className="mt-3 text-body text-danger">
          {t('cal.export.range')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-body text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function SubscriptionDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  const [grant, setGrant] = useState<CalendarSubscription | null>(null);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  const alive = useRef(true);
  const stillMounted = (): boolean => alive.current;
  const serverUrl = useSession((s) => s.serverUrl);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void calendarSubscription(workspaceId, 'GET', controller.signal)
      .then((g) => {
        if (!controller.signal.aborted) {
          setGrant(g);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(subscriptionError(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [workspaceId]);
  useEffect(() => {
    let active = true;
    if (grant?.connectUrl)
      void import('qrcode')
        .then((m) => m.toDataURL(grant.connectUrl, { width: 192, margin: 4, errorCorrectionLevel: 'M' }))
        .then((png) => {
          if (active) setQr(png);
        })
        .catch(() => {
          if (active) setError(t('cal.export.qrFailed'));
        });
    return () => {
      active = false;
    };
  }, [grant?.connectUrl]);
  const change = async (action: 'POST' | 'PUT' | 'DELETE'): Promise<void> => {
    if (busy) return;
    if (
      action !== 'POST' &&
      !(await confirmAction(
        t(action === 'PUT' ? 'cal.export.rotate' : 'cal.export.revoke'),
        t('cal.export.revokeHint'),
        t(action === 'PUT' ? 'cal.export.rotate' : 'cal.export.revoke'),
      ))
    )
      return;
    if (!stillMounted()) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'DELETE') {
        await revokeCalendarSubscription(workspaceId);
        if (stillMounted()) {
          setGrant(null);
          setLoaded(true);
        }
      } else {
        const next = await calendarSubscription(workspaceId, action);
        if (stillMounted()) { setQr(''); setGrant(next); }
      }
    } catch (e) {
      if (stillMounted()) setError(subscriptionError(e));
    } finally {
      if (stillMounted()) setBusy(false);
    }
  };
  const openApple = (): void => {
    if (!grant) return;
    // Use the active connection's origin, also when the installation has a canonical hostname alias.
    // The signed capability's path/query are server-issued; the native host still checks its origin.
    const origin = isWeb ? location.origin : serverUrl;
    try {
      const u = new URL(grant.feedUrl);
      const current = new URL(origin);
      const link = `webcal://${current.host}${u.pathname}${u.search}`;
      void platform.app.openExternal(link).catch(() => setError(t('cal.export.openFailed')));
    } catch {
      setError(t('cal.export.openFailed'));
    }
  };
  const copy = (): void => {
    if (!grant) return;
    void navigator.clipboard
      .writeText(grant.feedUrl)
      .then(() => toast.success(t('cal.linkCopied')))
      .catch(() => setError(t('cal.export.copyFailed')));
  };
  const enabled = !!grant?.feedUrl;
  return (
    <Modal open medium onClose={onClose} title={t('cal.export.subscribe')} description={t('cal.export.subscribeHint')} initialFocus="body">
      <p className="text-body text-muted">{t('cal.export.private')}</p>
      {enabled ? (
        <>
          <div className="mt-4 flex flex-col items-center gap-3">
            <Button disabled={busy} onClick={openApple} data-testid="calendar-apple">
              {t('cal.export.apple')}
            </Button>
            <div className="hidden flex-col items-center gap-2 mobile:hidden sm:flex">
              {qr ? <img src={qr} width={192} height={192} alt={t('cal.export.qr')} data-testid="calendar-qr" className="rounded-xl bg-white" /> : null}
              <p className="text-center text-caption text-muted">{t('cal.export.qr')}</p>
            </div>
          </div>
          <p className="mt-3 text-caption text-muted">{t('cal.export.updateHint')}</p>
          <details className="mt-4">
            <summary className="cursor-pointer text-body text-accent-text">{t('cal.export.settings')}</summary>
            <div className="mt-4 flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label={t('cal.export.link')}>
                  <Input readOnly value={grant.feedUrl} onFocus={(e) => e.target.select()} />
                </Field>
              </div>
              <Button variant="secondary" disabled={busy} onClick={copy}>
                {t('cal.export.copy')}
              </Button>
            </div>
            <p className="mt-3 text-caption text-muted">{t('cal.export.google')}</p>
            <p className="mt-2 text-caption text-muted">{t('cal.export.refresh')}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void change('PUT')}>
                {t('cal.export.rotate')}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void change('DELETE')}>
                {t('cal.export.revoke')}
              </Button>
            </div>
          </details>
        </>
      ) : loaded ? (
        <Button className="mt-4" busy={busy} onClick={() => void change('POST')} data-testid="calendar-activate">
          {t('cal.export.activate')}
        </Button>
      ) : busy ? (
        <p role="status" className="mt-4 text-body text-muted">
          {t('cal.export.loading')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-body text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

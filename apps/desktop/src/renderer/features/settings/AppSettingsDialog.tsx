import { requestNotify, readNotifyState, testNotification, type NotifyState } from '../../lib/notifyPermission';
import type { MediaPermissionKind } from '../../../shared/hostPermissions';
import { AuthorizedApps, useOAuthAppsAvailable } from '../identity/OAuth';
import { localAuthority } from '../identity/model';
import { AUDIO_TIERS_KBPS, audioTierKbps } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Bell, CalendarDays, CircleUser, Headphones, Info, Keyboard, Mic, MonitorSmartphone, SlidersHorizontal, Trash2, Wifi } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AppInfo, AppSettings, PermissionStatus } from '../../../shared/ipc';
import { Avatar } from '../../components/Avatar';
import { AvatarButtons } from '../../components/AvatarPicker';
import { confirmAction } from '../../components/Confirm';
import { Logo } from '../../components/Logo';
import { SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';
import { Badge, Button, Card, IconButton, Row, Segmented, Select, Slider, Spinner, Toggle, cx } from '../../components/ui';
import { availableLocales, LOCALE_NAMES, t, type LocalePref, type MessageKey } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { audioTierLabel } from '../../lib/audioTierLabel';
import { api, uploadAvatar } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { CHECK_IDS, runConnectionCheck, voiceProbeLine, type CheckId, type CheckRow } from '../../lib/connCheck';
import { log } from '../../lib/log';
import { METER_MIN_DB } from '../../lib/media/vad';
import { outputLabel } from '../../lib/media/outputKind';
import { musicianWarning, useMusicianAllowed } from '../../services/musician';
import { PlanLock } from '../../components/PlanLock';
import { platform } from '../../platform';
import { shortcutHelp } from '../../services/hotkeys';
import { logout } from '../../services/session';
import { voice } from '../../services/voice';
import { useNow } from '../shell/voiceFormat';
import { usePrefs, type Theme } from '../../stores/prefs';
import { selectUpdatePending, useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { ChangeEmailDialog, ChangePasswordDialog } from './CredentialDialogs';
import { LicenseCard } from '../legal/Legal';
import { HotkeyRow } from './HotkeyRow';
import { SettingsFooter } from './SettingsFooter';
import { EchoCard } from './EchoCard';
import { CommitInput } from './CommitInput';
import { PhoneRow, UsernameRow } from './ContactSettings';
import { MicMeter } from './MicMeter';
import { BoardHotkeysList } from '../boards/HotkeysSheet';
import { PttBinder } from './PttBinder';
import { PttReleaseDelay, PttReleaseLink } from './PttReleaseDelay';
import { AboutUpdateRow } from './AboutUpdateRow';
import { WebUpdateRow } from './WebUpdateRow';
import { deviceLabel, osLabel, voicePathLabel } from './format';
import { AfkCard } from '../shell/AfkCard';
import { SoundSettings } from '../people/SoundSettings';
import { CameraPreview, useCameras } from '../voice/CameraPreview';
import { BackgroundSmoothness } from '../voice/BackgroundPicker';
import { backgroundBlocked } from '../../services/cameraBackground';
import { StreamCodecSelect, streamCodecHint } from '../voice/StreamCodecSelect';
import { MyStickersCard } from './MyStickersCard';
import { BirthdaySettings } from './BirthdaySettings';
import { RemindersCard } from '../calendar/RemindersCard';
import { CalendarTab } from './CalendarSettings';

export function AppSettingsDialog({ tab, onClose }: { tab: string | undefined; onClose: () => void }): ReactNode {
  const superadmin = useSession((s) => s.me?.isSuperadmin === true);
  const guest = useSession((s) => s.me?.user?.isGuest === true);
  // «Обновление» on «О программе» while an update waits (docs/09 #125); a boolean selector.
  const updatePending = useSession(selectUpdatePending);
  const local = useSession((s) => localAuthority(s.authority));
  const oauthApps = useOAuthAppsAvailable();
  const sections: SettingsSection[] = [
    // «Основное» first (owner, 29.09): theme, language, startup / updates. The web has no startup /
    // updates, but the theme and the language live here too (ADR-0022).
    { id: 'general', label: t('settings.general'), icon: SlidersHorizontal, content: <GeneralTab /> },
    { id: 'profile', label: t('settings.profile'), icon: CircleUser, content: <ProfileTab /> },
    { id: 'voice', label: t('settings.voice'), icon: Mic, content: <VoiceTab /> },
    { id: 'hotkeys', label: t('settings.hotkeys'), icon: Keyboard, content: <HotkeysTab /> },
    { id: 'notifications', label: t('settings.notifications'), icon: Bell, content: <NotificationsTab /> },
    // Settings → Календарь (ADR-0041): work hours, the external CalDAV calendar; not for guests.
    ...(guest ? [] : [{ id: 'calendar', label: t('settings.calendar'), icon: CalendarDays, content: <CalendarTab /> }]),
    { id: 'connection', label: t('settings.connection'), icon: Wifi, content: <ConnectionTab /> },
    { id: 'sessions', label: t('settings.sessions'), icon: MonitorSmartphone, content: <SessionsTab /> },
    // «OAuth-приложения» (ADR-0054): near the end — rarely needed; Business only (PlanLock).
    { id: 'authorized-apps', label: t('identity.grants'), icon: AppWindow, locked: !oauthApps, content: <AuthorizedApps /> },
    // «О программе» always last (owner, 03.10).
    {
      id: 'about',
      label: t('settings.about'),
      icon: Info,
      content: <AboutTab />,
      keywords: t('settings.aboutKeywords'),
      ...(updatePending ? { badge: t('update.badge') } : {}),
    },
  ];
  return (
    <SettingsWindow
      title={t('settings.title')}
      initial={tab}
      fallback="general"
      onClose={onClose}
      sections={sections.filter((section) => local || !['profile', 'sessions', 'calendar'].includes(section.id))}
      footer={
        <SettingsFooter
          superadmin={superadmin}
          // One dialog at a time: the admin window replaces settings (same as the status menu item).
          onAdmin={() => useUi.getState().openDialog({ kind: 'admin' })}
          onLogout={() => void logout()}
        />
      }
    />
  );
}

// ---------------------------------------------------------------- profile

function ProfileTab(): ReactNode {
  const me = useSession((s) => s.me);
  const [credDialog, setCredDialog] = useState<'password' | 'email' | 'email-code' | 'email-cancel' | 'email-verify' | null>(null);
  const update = async (init: Parameters<typeof api.me.update>[0]): Promise<void> => {
    const r = await api.me.update(init);
    if (r.me) useSession.getState().set({ me: r.me });
    // My own card and rows read `users` (ADR-0077: nickname, phone) before USER_UPDATE comes back.
    if (r.me?.user) useWorkspaces.getState().upsertUser(r.me.user);
  };
  const setAvatar = async (f: File): Promise<void> => {
    await uploadAvatar(f, f.name);
    const r = await api.me.get();
    if (r.me) useSession.getState().set({ me: r.me });
  };
  const u = me?.user;
  if (!me || !u) return null;
  return (
    <>
      <div className="flex items-center gap-4">
        <Avatar userId={u.id} name={u.displayName} fileId={u.avatarFileId || undefined} size={64} />
        <div className="flex min-w-0 flex-col gap-2">
          <div className="truncate text-headline font-semibold">{u.displayName}</div>
          <AvatarButtons hasAvatar={!!u.avatarFileId} onUpload={setAvatar} onRemove={() => update({ avatarFileId: '' })} />
        </div>
      </div>
      <Card title={t('card.basics')}>
        <Row label={t('profile.name')}>
          <CommitInput label={t('profile.name')} value={u.displayName} maxLength={100} onCommit={(v) => (v ? update({ displayName: v }) : undefined)} />
        </Row>
        <Row label={t('profile.status')}>
          <CommitInput label={t('profile.status')} value={u.statusText} maxLength={128} placeholder={t('profile.statusPh')} onCommit={(v) => update({ statusText: v })} />
        </Row>
        {/* ADR-0077: guest accounts have neither (server: 403). */}
        {u.isGuest ? null : <UsernameRow value={u.username} onSave={(username) => update({ username })} />}
        {u.isGuest ? null : <PhoneRow value={u.phone} onSave={(phone) => update({ phone })} />}
        {/* Guests have no password of their own (server: 403 FORBIDDEN): no rows to change it. */}
        <Row
          label={t('profile.email')}
          hint={
            me.pendingEmail ? (
              // ADR-0023: the new address waits for its code; login stays on the old one.
              <span className="flex flex-wrap items-center gap-x-2" data-testid="pending-email">
                <span>{t('mail.change.pending', { email: me.pendingEmail })}</span>
                <button type="button" className="rounded-[var(--radius-control)] text-accent-text hover:underline" onClick={() => setCredDialog('email-code')}>
                  {t('mail.change.enterCode')}
                </button>
                <button type="button" className="rounded-[var(--radius-control)] text-accent-text hover:underline" onClick={() => setCredDialog('email-cancel')}>
                  {t('mail.change.cancel')}
                </button>
              </span>
            ) : !me.emailVerified && !u.isGuest ? (
              // ADR-0065: with EMAIL_VERIFICATION=optional nothing asks for the code, so this is where
              // the address gets confirmed (also with required, next to the bar).
              <span className="flex flex-wrap items-center gap-x-2" data-testid="unverified-email">
                <span>{t('mail.unverified')}</span>
                <button type="button" className="rounded-[var(--radius-control)] text-accent-text hover:underline" onClick={() => setCredDialog('email-verify')}>
                  {t('mail.confirm')}
                </button>
              </span>
            ) : undefined
          }
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="selectable min-w-0 max-w-60 truncate text-body text-muted" title={me.email}>
              {me.email}
            </span>
            {u.isGuest ? null : (
              <Button variant="secondary" aria-label={t('cred.changeEmail')} onClick={() => setCredDialog('email')}>
                {t('cred.change')}
              </Button>
            )}
          </span>
        </Row>
        {u.isGuest ? null : (
          <Row label={t('cred.password')}>
            <Button variant="secondary" aria-label={t('cred.changePassword')} onClick={() => setCredDialog('password')}>
              {t('cred.change')}
            </Button>
          </Row>
        )}
      </Card>
      {/* docs/09 #76; guests have no birthday (server: 403). */}
      {u.isGuest ? null : <BirthdaySettings />}
      {credDialog === 'password' ? <ChangePasswordDialog onClose={() => setCredDialog(null)} /> : null}
      {credDialog === 'email' ? <ChangeEmailDialog onClose={() => setCredDialog(null)} /> : null}
      {credDialog === 'email-code' ? <ChangeEmailDialog mode="confirm" onClose={() => setCredDialog(null)} /> : null}
      {credDialog === 'email-cancel' ? <ChangeEmailDialog mode="cancel" onClose={() => setCredDialog(null)} /> : null}
      {credDialog === 'email-verify' ? <ChangeEmailDialog mode="verify" onClose={() => setCredDialog(null)} /> : null}
      <AfkCard />
      {/* Guest accounts do not install sticker packs (ADR-0030 §4). */}
      {u.isGuest ? null : <MyStickersCard />}
    </>
  );
}

// ---------------------------------------------------------------- voice & devices

function useDevices(): { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] } {
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = (): void => void navigator.mediaDevices.enumerateDevices().then(setDevs);
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    const id = window.setTimeout(load, 1500); // labels appear after mic permission
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', load);
      window.clearTimeout(id);
    };
  }, []);
  return { inputs: devs.filter((d) => d.kind === 'audioinput'), outputs: devs.filter((d) => d.kind === 'audiooutput') };
}

const STATUS_LABEL: Record<string, MessageKey | null> = {
  granted: 'perm.granted',
  denied: 'perm.denied',
  'not-determined': 'perm.notDetermined',
  restricted: 'perm.restricted',
  default: 'perm.notDetermined',
  'n/a': null,
  unsupported: null,
};

function statusText(s: string): string {
  const k = STATUS_LABEL[s];
  return k === undefined ? s : k === null ? '—' : t(k);
}

export function PermissionsCard(): ReactNode {
  const [p, setP] = useState<PermissionStatus | null>(null);
  const [requesting, setRequesting] = useState<MediaPermissionKind | null>(null);
  const [notif, setNotif] = useState<NotifyState>(() => readNotifyState(undefined, platform.notifications));
  const os = useSession((s) => s.appInfo?.platform);
  const mac = os === 'darwin' && platform.kind === 'electron';
  useEffect(() => {
    const refresh = (): void => {
      void platform.system.permissions().then(setP);
      if (platform.notifications) void platform.notifications.state().then(s => setNotif(s.permission));
      else setNotif(readNotifyState());
    };
    refresh();
    const unsubscribe = platform.notifications?.subscribe(s => setNotif(s.permission));
    const unsubscribeMedia = platform.mediaPermissions?.subscribe(state => setP(previous => previous ? { ...previous, ...state } : previous));
    window.addEventListener('focus', refresh); // back from System Settings
    return () => { unsubscribe?.(); unsubscribeMedia?.(); window.removeEventListener('focus', refresh); };
  }, []);
  if (!p) return null;
  const openAppSettings = (): void => {
    void platform.mediaPermissions?.openSettings().then(opened => { if (!opened) toast.error(t('perm.openFailed')); });
  };
  const mediaButton = (kind: MediaPermissionKind): ReactNode => {
    const host = platform.mediaPermissions;
    if (!host) return osButton(kind);
    if (p[kind] === 'not-determined') return (
      <Button size="sm" variant="secondary" disabled={requesting !== null} busy={requesting === kind} onClick={() => {
        setRequesting(kind);
        void host.request(kind).then(state => setP(previous => previous ? { ...previous, ...state } : previous)).finally(() => setRequesting(null));
      }}>{t('perm.ask')}</Button>
    );
    if (p[kind] === 'denied' || p[kind] === 'restricted') return <Button size="sm" variant="secondary" onClick={openAppSettings}>{t('perm.openOs')}</Button>;
    return null;
  };
  const osButton = (pane: 'microphone' | 'camera' | 'screen' | 'accessibility'): ReactNode =>
    mac || ((pane === 'microphone' || pane === 'camera') && os === 'win32' && platform.kind === 'electron') ? (
      <Button size="sm" variant="secondary" onClick={() => void platform.system.openPrivacySettings(pane)}>
        {t('perm.openOs')}
      </Button>
    ) : null;
  return (
    <Card title={t('perm.title')} footer={t(platform.mediaPermissions ? 'perm.phoneHint' : 'perm.hint')}>
      <Row label={t('perm.mic')}>
        <span className="text-body text-muted">{statusText(p.microphone)}</span>
        {mediaButton('microphone')}
      </Row>
      <Row label={t('video.device')}>
        <span className="text-body text-muted">{statusText(p.camera)}</span>
        {mediaButton('camera')}
      </Row>
      {mac ? (
        <>
          <Row label={t('perm.screen')} hint={t('perm.screenHint')}>
            <span className="text-body text-muted">{statusText(p.screen)}</span>
            {osButton('screen')}
          </Row>
          <Row label={t('perm.input')} hint={t('perm.inputHint')}>
            <span className="text-body text-muted">{statusText(p.accessibility ? 'granted' : 'not-determined')}</span>
            {osButton('accessibility')}
          </Row>
        </>
      ) : null}
      <Row label={t('perm.notifications')}>
        <span className="text-body text-muted">{statusText(notif)}</span>
        {notif === 'default' ? (
          <Button size="sm" variant="secondary" onClick={() => void requestNotify(undefined, platform.notifications).then(setNotif)}>
            {t('perm.ask')}
          </Button>
        ) : null}
        {notif === 'denied' && platform.mediaPermissions ? <Button size="sm" variant="secondary" onClick={openAppSettings}>{t('perm.openOs')}</Button> : null}
      </Row>
    </Card>
  );
}

function VoiceTab(): ReactNode {
  const p = usePrefs();
  const { inputs, outputs } = useDevices();
  const cameras = useCameras();
  const [preview, setPreview] = useState(false);
  const [testing, setTesting] = useState(false);
  const vad = useVoice((s) => s.vad);
  const micError = useVoice((s) => s.micError);

  useEffect(
    () => () => {
      voice.stopMicTest();
    },
    [],
  );

  return (
    <>
      <Card title={t('voice.devices')}>
        <Row label={t('voice.input')}>
          <Select aria-label={t('voice.input')} className="w-60" value={p.micDeviceId ?? ''} onChange={(e) => p.setPrefs({ micDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {inputs
              .filter((d) => d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
          </Select>
        </Row>
        <Row label={t('voice.output')} hint={t('voice.outputHint')}>
          <Select aria-label={t('voice.output')} className="w-60" value={p.outputDeviceId ?? ''} onChange={(e) => p.setPrefs({ outputDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {outputs
              .filter((d) => d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
          </Select>
        </Row>
        <div className="flex flex-col gap-2 px-3 py-3" data-settings-row>
          <div className="flex items-center justify-between gap-4">
            <span className="text-body" data-settings-label>
              {t('voice.micTest')}
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                if (testing) voice.stopMicTest();
                else void voice.startMicTest();
                setTesting(!testing);
              }}
            >
              {testing ? t('voice.stopTest') : t('voice.startTest')}
            </Button>
          </div>
          <MicMeter />
          {/* Speech probability only means something while the test is running. */}
          {testing ? (
            <span className="text-caption text-faint">
              {t('voice.vad')}: {vad === null ? t('voice.vadOff') : `${Math.round(vad * 100)}%`}
            </span>
          ) : null}
          {micError ? (
            <span className="text-caption text-danger-text" role="alert">
              {micError}
            </span>
          ) : null}
        </div>
      </Card>

      <Card title={t('video.card')}>
        <Row label={t('video.device')} hint={t('video.deviceHint')}>
          <Select aria-label={t('video.device')} className="w-60" value={p.cameraDeviceId ?? ''} onChange={(e) => p.setPrefs({ cameraDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {cameras.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || d.deviceId.slice(0, 8)}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t('video.previewRow')}>
          <Button variant="secondary" onClick={() => setPreview(true)}>
            {t('video.checkShort')}
          </Button>
          {/* Nested sheet: the settings stay open underneath. */}
          {preview ? <CameraPreview onClose={() => setPreview(false)} /> : null}
        </Row>
        {p.cameraBackground.kind !== 'none' && backgroundBlocked() === null ? (
          <Row label={t('video.bg.fps')} hint={t('video.bg.fpsHint')}>
            <BackgroundSmoothness />
          </Row>
        ) : null}
        <Row label={t('video.saveTraffic')} hint={t('video.saveTrafficHint')}>
          <Toggle label={t('video.saveTraffic')} checked={p.saveTraffic} onChange={(v) => p.setPrefs({ saveTraffic: v })} />
        </Row>
      </Card>

      <Card title={t('video.screenCard')}>
        <Row label={t('video.streamCodec')} hint={streamCodecHint(p.streamCodec)}>
          <StreamCodecSelect />
        </Row>
      </Card>

      <Card title={t('voice.mode')}>
        <Row label={t('voice.mode')}>
          <Segmented
            label={t('voice.mode')}
            value={p.micMode}
            onChange={(m) => p.setPrefs({ micMode: m })}
            options={[
              { value: 'voice', label: t('voice.modeVad') },
              { value: 'ptt', label: t('voice.modePtt') },
            ]}
          />
        </Row>
        {p.micMode === 'voice' ? (
          <div className="flex flex-col gap-2 px-3 py-3" data-settings-row>
            <div className="flex justify-between text-body">
              <span data-settings-label data-settings-hint={t('voice.thresholdHint')}>
                {t('voice.thresholdLabel')}
              </span>
              <span className="tabular-nums text-muted">{t('unit.db', { n: p.thresholdDb })}</span>
            </div>
            <Slider label={t('voice.thresholdLabel')} value={p.thresholdDb} min={METER_MIN_DB} max={0} onChange={(v) => p.setPrefs({ thresholdDb: v })} />
            <span className="text-caption text-faint">{t('voice.thresholdHint')}</span>
          </div>
        ) : (
          <>
            <PttBinder />
            <PttReleaseDelay />
          </>
        )}
      </Card>

      <EchoCard />

      <Card title={t('voice.processing')} footer={p.musicianMode ? t('music.aecNote') : t('voice.aecNote')}>
        <MusicianRow outputs={outputs} />
        <Row label={t('voice.rnnoise')} hint={p.musicianMode ? t('music.rnnoiseOff') : t('voice.rnnoiseHint')}>
          <Toggle label={t('voice.rnnoise')} checked={p.rnnoise && !p.musicianMode} disabled={p.musicianMode} onChange={(v) => p.setPrefs({ rnnoise: v })} />
        </Row>
        <Row label={t('voice.red')} hint={t('voice.redHint')}>
          <Toggle label={t('voice.red')} checked={p.red} onChange={(v) => p.setPrefs({ red: v })} />
        </Row>
        <Row label={t('voice.myBitrate')} hint={t('voice.myBitrateHint')}>
          <Select
            aria-label={t('voice.myBitrate')}
            className="w-60"
            value={p.personalBitrateKbps ? audioTierKbps(p.personalBitrateKbps) : ''}
            onChange={(e) => p.setPrefs({ personalBitrateKbps: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">{t('voice.myBitrateRoom')}</option>
            {AUDIO_TIERS_KBPS.map((b) => (
              <option key={b} value={b}>
                {t('voice.myBitrateCap', { v: audioTierLabel(b) })}
              </option>
            ))}
          </Select>
        </Row>
      </Card>

      <SoundboardCard />

      <PermissionsCard />
    </>
  );
}

/**
 * «Режим музыканта» (ADR-0052): the toggle and, while it is on, the echo warning under it — the
 * stronger one when the output looks like loudspeakers (outputKind, by the device label).
 */
function MusicianRow({ outputs }: { outputs: MediaDeviceInfo[] }): ReactNode {
  const on = usePrefs((s) => s.musicianMode);
  const outputId = usePrefs((s) => s.outputDeviceId);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const allowed = useMusicianAllowed();
  const warning = on ? musicianWarning(outputLabel(outputs, outputId)) : null;
  const row = (
    <Row label={t('music.mode')} hint={t('music.hint')}>
      <Toggle label={t('music.mode')} checked={on && allowed} disabled={!allowed} onChange={(v) => setPrefs({ musicianMode: v })} />
    </Row>
  );
  // Free (ADR-0052): the switch stays in place under the plan lock (docs/08 «Функции не по тарифу»).
  if (!allowed)
    return (
      <PlanLock plan="team" testId="musician-lock">
        {row}
      </PlanLock>
    );
  return (
    <div data-testid="musician-row">
      {row}
      {warning ? (
        <div
          role="status"
          className={cx('mx-3 mb-3 flex items-start gap-2 rounded-[var(--radius-row)] bg-mention px-2 py-1.5 text-[12px]', warning.strong ? 'text-danger-text' : 'text-fg')}
        >
          <Headphones className={cx('mt-px size-4 shrink-0', warning.strong ? 'text-danger' : 'text-warn')} aria-hidden />
          <span>{warning.text}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * «Звуки в комнату» (ADR-0036 §3): the soundboard's own volume (0–200 %: × the headphones ▾
 * volume, the element caps at 100 % — no WebAudio gain, docs/02) and «Не воспроизводить звуки
 * других». «Слабый компьютер» does not change it.
 */
function SoundboardCard(): ReactNode {
  const volume = usePrefs((s) => s.soundboardVolume);
  const muteOthers = usePrefs((s) => s.soundboardMuteOthers);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const pct = Math.round(volume * 100);
  return (
    <Card title={t('snd.card')}>
      <div className="flex flex-col gap-2 px-3 py-3" data-settings-row>
        <div className="flex justify-between text-body">
          <span data-settings-label data-settings-hint={t('snd.volumeHint')}>
            {t('snd.volume')}
          </span>
          <span className="tabular-nums text-muted">{pct} %</span>
        </div>
        <Slider label={t('snd.volume')} value={pct} min={0} max={200} step={5} onChange={(v) => setPrefs({ soundboardVolume: v / 100 })} />
        <span className="text-caption text-faint">{t('snd.volumeHint')}</span>
      </div>
      <Row label={t('snd.muteOthers')} hint={t('snd.muteOthersHint')}>
        <Toggle label={t('snd.muteOthers')} checked={muteOthers} onChange={(v) => setPrefs({ soundboardMuteOthers: v })} />
      </Row>
    </Card>
  );
}

// ---------------------------------------------------------------- hotkeys

function Kbd({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-[var(--radius-row)] border border-line bg-elev px-1.5 font-sans text-caption tabular-nums text-fg shadow-[var(--shadow-card)]">
      {children}
    </kbd>
  );
}

/** Settings → «Горячие клавиши» (docs/09 #18): the push-to-talk binder + the in-window shortcuts. */
function HotkeysTab(): ReactNode {
  return (
    <>
      <Card title={t('hotkeys.ptt')} footer={t('hotkeys.pttFooter')}>
        <PttBinder />
        <PttReleaseLink />
      </Card>
      <Card title={t('hotkeys.app')} footer={t('hotkeys.appFooter')}>
        {shortcutHelp().map((s) =>
          s.action ? (
            <HotkeyRow key={s.label} action={s.action} kbd={(k) => <Kbd>{k}</Kbd>} />
          ) : (
            <Row key={s.label} label={t(s.label)}>
              <Kbd>{s.keys}</Kbd>
            </Row>
          ),
        )}
      </Card>
      {/* Task boards (ADR-0042 «Хоткеи»): the registry, read-only («Клавиши»). */}
      <Card title={t('boards.hotkeysCard')} footer={t('boards.hotkeysFooter')}>
        <div className="px-3 py-2">
          <BoardHotkeysList columns={1} />
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- notifications

function NotificationsTab(): ReactNode {
  const p = usePrefs();
  const [testing, setTesting] = useState(false);
  const show = async (): Promise<void> => {
    if (testing) return;
    setTesting(true);
    const result = await testNotification(t('notify.testBody'), platform.notifications);
    setTesting(false);
    if (result === 'denied') toast.info(t(platform.kind === 'electron' || platform.notifications ? 'onb.notifDenied' : 'onb.notifDeniedWeb'));
    else if (result === 'update') toast.info(t('notify.updateApp'));
    else if (result === 'unsupported') toast.info(t('notify.unavailable'));
    else if (result === 'failed') toast.error(t('notify.testFailed'));
  };
  return (
    <>
      <Card title={t('card.desktopNotifications')}>
        <Row label={t('notify.mentions')} hint={t('notify.mentionsHint')}>
          <Toggle label={t('notify.mentions')} checked={p.notifyMentions} onChange={(v) => p.setPrefs({ notifyMentions: v })} />
        </Row>
        <Row label={t('notify.all')} hint={t('notify.allHint')}>
          <Toggle label={t('notify.all')} checked={p.notifyAll} onChange={(v) => p.setPrefs({ notifyAll: v })} />
        </Row>
        <Row label={t('notify.test')} hint={platform.notifications ? t('notify.localTestHint') : undefined}>
          <Button
            variant="secondary"
            busy={testing}
            onClick={() => void show()}
          >
            {t('notify.testBtn')}
          </Button>
        </Row>
      </Card>
      <PushPrivacyCard />
      <RemindersCard />
      <SoundSettings />
    </>
  );
}

function PushPrivacyCard(): ReactNode {
  const hidden = useSession((s) => s.me?.settings?.hideMessageTextInNotifications);
  const eligible = useSession((s) => !!s.me?.settings && !s.me.user?.isGuest && !s.me.user?.isBot);
  const local = useSession((s) => localAuthority(s.authority));
  const [pending, setPending] = useState(false);
  if (!local || !eligible) return null;
  const save = async (hidden: boolean): Promise<void> => {
    setPending(true);
    try {
      const response = await api.me.update({ hideMessageTextInNotifications: hidden });
      if (response.me) useSession.getState().set({ me: response.me });
    } catch (e) {
      toast.fail(e, t('err.ctx.save'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Card title={t('notify.mobilePush')}>
      <Row label={t('notify.messagePreview')} hint={t('notify.messagePreviewHint')}>
        <Toggle label={t('notify.messagePreview')} checked={hidden !== true}
          disabled={pending} onChange={(v) => void save(!v)} />
      </Row>
    </Card>
  );
}

// ---------------------------------------------------------------- connection

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ConnectionTab(): ReactNode {
  const serverUrl = useSession((s) => s.serverUrl);
  const gateway = useSession((s) => s.gateway);
  const pair = useVoice((s) => s.stats?.pair ?? null);
  const inVoice = useVoice((s) => s.roomId !== null);
  const phase = useVoice((s) => s.phase);
  const link = useVoice((s) => s.link);
  const stats = useVoice((s) => s.stats);
  const [ping, setPing] = useState<{ ms: number | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<CheckRow[] | null>(null);
  /** «Голос: подключён, RTT 31 мс» — the live connection itself, not only the paths (docs/09 #131). */
  const [voiceLine, setVoiceLine] = useState<{ text: string; ok: boolean } | null>(null);

  // Round trip of the lightest authenticated API call (/healthz is not proxied publicly).
  const measure = useCallback(async (): Promise<void> => {
    const t0 = performance.now();
    try {
      const r = await platform.apiFetch('/api/me');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPing({ ms: Math.round(performance.now() - t0), error: null });
    } catch (e) {
      setPing({ ms: null, error: errorText(e, t('conn.checkFailed')) });
    }
  }, []);
  // «Проверить»: every path voice needs (lib/connCheck), rows appear as they finish.
  const check = async (): Promise<void> => {
    setBusy(true);
    setRows([]);
    setVoiceLine(voiceProbeLine(voice.linkProbe()));
    await measure();
    const { url, token, iceServers } = voice.linkInfo();
    try {
      await runConnectionCheck({ apiFetch: (path) => platform.apiFetch(path), rtcUrl: url, token, iceServers }, (r) => setRows((prev) => [...(prev ?? []), r]));
    } catch (e) {
      log.warn('connection check failed', e);
    } finally {
      setBusy(false);
    }
  };
  const ready = gateway === 'ready';
  // «Сервер: Подключено · 23 мс» — measured when the page opens and every 15 s while it is open.
  useEffect(() => {
    if (!ready) return;
    const first = window.setTimeout(() => void measure(), 0);
    const id = window.setInterval(() => void measure(), 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [ready, measure]);

  const path = voicePathLabel(pair);
  const host = serverUrl ? hostOf(serverUrl) : '';
  return (
    <Card title={t('card.status')}>
      <Row label={t('conn.gateway')} hint={host || undefined}>
        <span className={cx('text-body', ready ? 'text-ok' : 'text-warn')}>
          {ready ? t('conn.ok') : t('conn.connecting')}
          {ready && ping?.ms !== null && ping?.ms !== undefined ? (
            <span className="tabular-nums text-muted" title={t('conn.apiOkHint')}>
              {' '}
              · {t('conn.apiOk', { ms: ping.ms })}
            </span>
          ) : null}
        </span>
      </Row>
      {ping?.error ? (
        <p className="px-3 py-2 text-caption text-danger-text" role="alert">
          {ping.error}
        </p>
      ) : null}
      {/* «Голос»: the phase, failed attempts in a row, the LiveKit host and the last error. */}
      <Row label={t('conn.voicePath')} hint={link.rtcHost ?? undefined}>
        <span className={cx('text-body', phase === 'blocked' ? 'text-danger-text' : phase === 'reconnecting' || phase === 'connecting' ? 'text-warn' : 'text-muted')}>
          {phase === 'blocked'
            ? t('conn.voiceBlocked')
            : phase === 'reconnecting'
              ? t('voice.reconnecting')
              : inVoice
                ? phase === 'connected'
                  ? (path ?? t('conn.ok'))
                  : t('conn.connecting')
                : t('conn.notInVoice')}
          {inVoice && (phase === 'connecting' || phase === 'reconnecting') ? <VoicePhaseAge /> : null}
          {link.attempts > 0 && phase !== 'connected' ? (
            <span className="tabular-nums text-muted"> · {t('conn.voiceAttempts', { n: link.attempts })}</span>
          ) : null}
        </span>
      </Row>
      {link.lastError && phase !== 'connected' ? (
        <p className="break-words px-3 py-2 text-caption text-danger-text" role="alert">
          {t('conn.lastError', { error: link.lastError })}
        </p>
      ) : null}
      {stats ? (
        <Row label={t('conn.traffic')}>
          <span className="text-body tabular-nums text-muted">
            ↑ {Math.round(stats.totalOutKbps)} / ↓ {t('unit.kbps', { n: Math.round(stats.totalInKbps) })}
          </span>
        </Row>
      ) : null}
      <Row label={t('conn.check')}>
        <Button variant="secondary" busy={busy} onClick={() => void check()}>
          {t('conn.checkBtn')}
        </Button>
      </Row>
      {rows ? (
        <div data-testid="conn-check">
          {voiceLine ? (
            <Row label={t('conn.row.voice')}>
              <span className={cx('shrink-0 text-body', voiceLine.ok ? 'text-ok' : 'text-warn')}>{voiceLine.text}</span>
            </Row>
          ) : null}
          {CHECK_IDS.map((id) => (
            <CheckResultRow key={id} id={id} row={rows.find((r) => r.id === id)} />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/** « · 45 с» after «Подключение…» / «Переподключение…»: its own 1 s clock, mounted only then (docs/14). */
function VoicePhaseAge(): ReactNode {
  useNow(1000);
  const ms = voice.linkProbe().stuckMs;
  return ms === null ? null : <span className="tabular-nums text-muted"> · {t('conn.voiceFor', { s: Math.round(ms / 1000) })}</span>;
}

const CHECK_LABEL: Record<CheckId, 'conn.row.api' | 'conn.row.rtcHttps' | 'conn.row.rtcWss' | 'conn.row.turnUdp' | 'conn.row.turnTls'> = {
  api: 'conn.row.api',
  rtcHttps: 'conn.row.rtcHttps',
  rtcWss: 'conn.row.rtcWss',
  turnUdp: 'conn.row.turnUdp',
  turnTls: 'conn.row.turnTls',
};

/** One line of the check table: the path, PASS/FAIL (+ ms) and the error text as the hint. */
function CheckResultRow({ id, row }: { id: CheckId; row: CheckRow | undefined }): ReactNode {
  return (
    <Row label={t(CHECK_LABEL[id])} hint={row?.detail ?? undefined}>
      {row ? (
        <span className={cx('shrink-0 text-body', row.status === 'pass' ? 'text-ok' : row.status === 'fail' ? 'text-danger-text' : 'text-muted')}>
          {row.status === 'pass' ? t('conn.pass') : row.status === 'fail' ? t('conn.fail') : t('conn.skip')}
          {row.ms !== null ? <span className="tabular-nums text-muted"> · {t('unit.ms', { n: row.ms })}</span> : null}
        </span>
      ) : (
        <Spinner />
      )}
    </Row>
  );
}

// ---------------------------------------------------------------- sessions

function SessionsTab(): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.me.sessions() });
  const revoke = useMutation({
    mutationFn: (id: string) => api.me.revokeSession(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (e) => toast.fail(e, t('err.ctx.save')),
  });
  const others = q.data?.sessions.filter((s) => !s.current) ?? [];
  const revokeOthers = useMutation({
    mutationFn: () => Promise.all(others.map((s) => api.me.revokeSession(s.id))),
    onSuccess: () => {
      toast.success(t('sessions.revokeOthersDone'));
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => {
      toast.fail(e, t('err.ctx.save'));
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  return (
    <>
      {q.isLoading ? <Spinner /> : null}
      {q.error ? <p className="text-body text-danger-text">{errorText(q.error, t('err.ctx.load'))}</p> : null}
      {q.data ? (
        <Card
          title={t('card.sessions')}
          footer={
            others.length > 0 ? (
              <Button
                variant="destructive"
                size="sm"
                busy={revokeOthers.isPending}
                className="-ml-1 mt-1"
                onClick={() =>
                  void confirmAction(t('sessions.logoutAll'), t('sessions.logoutAllText'), t('sessions.logoutAll')).then((ok) => ok && revokeOthers.mutate())
                }
              >
                {t('sessions.logoutAll')}
              </Button>
            ) : undefined
          }
        >
          {q.data.sessions.map((s) => (
            <Row
              key={s.id}
              label={deviceLabel(s.deviceName || s.userAgent || '—')}
              hint={`${s.ip} · ${t('sessions.lastSeen')} ${s.lastSeenAt ? fmt.stamp(timestampDate(s.lastSeenAt)) : '—'}`}
            >
              {s.current ? (
                <Badge>{t('sessions.current')}</Badge>
              ) : (
                <IconButton label={t('sessions.revoke')} className="text-muted hover:text-danger" onClick={() => revoke.mutate(s.id)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </Row>
          ))}
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- general (theme, language, desktop) / about

function GeneralTab(): ReactNode {
  const info = useSession((s) => s.appInfo);
  const settings = useSession((s) => s.settings);
  const save = async (patch: Parameters<typeof platform.app.setSettings>[0]): Promise<void> => {
    const s = await platform.app.setSettings(patch);
    useSession.getState().set({ settings: s });
  };
  const desktop = platform.kind === 'electron';
  return (
    <>
      <ThemeCard />
      <LanguageCard />
      {desktop ? <DesktopAppCards info={info} settings={settings} save={save} /> : null}
    </>
  );
}

function ThemeCard(): ReactNode {
  const theme = usePrefs((s) => s.theme);
  const set = usePrefs((s) => s.setPrefs);
  return (
    <Card title={t('card.look')}>
      <Row label={t('settings.theme')}>
        <Segmented<Theme>
          label={t('settings.theme')}
          value={theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
            { value: 'system', label: t('theme.system') },
          ]}
        />
      </Row>
    </Card>
  );
}

function LanguageCard(): ReactNode {
  const locale = usePrefs((s) => s.locale);
  const set = usePrefs((s) => s.setPrefs);
  return (
    <Card title={t('lang.label')}>
      <Row label={t('lang.label')} hint={t('lang.hint')}>
        <Select aria-label={t('lang.label')} className="w-60" value={locale} onChange={(e) => set({ locale: e.target.value as LocalePref })}>
          <option value="auto">{t('lang.auto')}</option>
          {availableLocales().map((l) => (
            <option key={l} value={l} lang={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </Select>
      </Row>
    </Card>
  );
}

function DesktopAppCards({
  info,
  settings,
  save,
}: {
  info: AppInfo | null;
  settings: AppSettings | null;
  save: (patch: Partial<AppSettings>) => Promise<void>;
}): ReactNode {
  return (
    <>
      <Card title={t('card.startup')}>
        <Row label={t('app.autostart')} hint={info?.packaged ? undefined : t('app.autostartDev')}>
          <Toggle
            label={t('app.autostart')}
            checked={settings?.autostart ?? false}
            onChange={(v) => void save({ autostart: v }).catch((e: unknown) => toast.fail(e, t('err.ctx.save')))}
          />
        </Row>
        {/* macOS always hides on close, like every Mac app — no choice there (docs/09 #31). */}
        {info && info.platform !== 'darwin' ? (
          <Row label={t('app.onClose')} hint={t('app.onCloseHint')}>
            <Segmented<'tray' | 'quit'>
              label={t('app.onClose')}
              value={(settings?.closeToTray ?? true) ? 'tray' : 'quit'}
              options={[
                { value: 'tray', label: t('app.onCloseTray') },
                { value: 'quit', label: t('app.onCloseQuit') },
              ]}
              onChange={(v) => void save({ closeToTray: v === 'tray' }).catch((e: unknown) => toast.fail(e, t('err.ctx.save')))}
            />
          </Row>
        ) : null}
      </Card>
      {/* Main decides what «auto» means per platform (updateFlow.ts); the renderer only toggles. */}
      <Card title={t('about.updates')}>
        <Row label={t('app.autoCheckUpdates')} hint={t('app.autoCheckUpdatesHint')}>
          <Toggle
            label={t('app.autoCheckUpdates')}
            checked={settings?.autoCheckUpdates ?? true}
            onChange={(v) => void save({ autoCheckUpdates: v }).catch((e: unknown) => toast.fail(e, t('err.ctx.save')))}
          />
        </Row>
        <Row label={t('app.autoUpdate')} hint={t('app.autoUpdateHint')}>
          <Toggle
            label={t('app.autoUpdate')}
            checked={settings?.autoUpdate ?? true}
            onChange={(v) => void save({ autoUpdate: v }).catch((e: unknown) => toast.fail(e, t('err.ctx.save')))}
          />
        </Row>
      </Card>
    </>
  );
}

/** «О программе»: logo, version, updates (desktop), and the developer switches out of the way. */
function AboutTab(): ReactNode {
  const info = useSession((s) => s.appInfo);
  const devStats = usePrefs((s) => s.devStats);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const desktop = platform.kind === 'electron';
  const version = info?.version ?? '—';
  const webUpdate = useSession((s) => s.webVersion !== '');
  return (
    <>
      <div className="flex flex-col items-center gap-2 py-2 text-center">
        <Logo size={80} />
        <h3 className="text-title font-semibold">Calab</h3>
        <p className="text-body text-muted">{t('about.tagline')}</p>
        {/* Desktop: the version heads the update row below (docs/09 #93). */}
        {desktop ? null : <p className="selectable text-caption text-faint">{t('about.version', { v: version })}</p>}
      </div>
      {desktop ? (
        <Card title={t('about.updates')}>
          <AboutUpdateRow version={version} />
        </Card>
      ) : webUpdate ? (
        <Card title={t('about.updates')}>
          <WebUpdateRow version={version} />
        </Card>
      ) : null}
      <LicenseCard />
      <Card title={t('about.dev')}>
        <Row label={t('app.devStats')} hint={t('app.devStatsHint')}>
          <Toggle label={t('app.devStats')} checked={devStats} onChange={(v) => setPrefs({ devStats: v })} />
        </Row>
        {desktop ? (
          <Row label={t('about.devVersions')}>
            <span className="selectable text-body text-muted">
              Electron {info?.electron ?? '—'} · Chromium {info?.chrome ?? '—'}
            </span>
          </Row>
        ) : null}
        <Row label={t('about.devPlatform')}>
          <span className="selectable text-body text-muted">{osLabel(info?.platform)}</span>
        </Row>
      </Card>
    </>
  );
}

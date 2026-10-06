import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Bell, CalendarDays, ChevronDown, ChevronRight, CircleUser, HeadphoneOff, Headphones, Info, LogOut, Mic, MicOff, MonitorSmartphone, ShieldCheck, SlidersHorizontal, Wifi, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { voice } from '../../services/voice';
import { logout } from '../../services/session';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { localAuthority } from '../identity/model';
import { AppSettingsWindow } from './lazyWindows';
import { DeviceMenu, MicMenu } from './SelfPanel';
import { STATUS_KEY, StatusMenu, useCustomStatusExpiry, useMyStatus } from './StatusMenu';

/**
 * «Профиль» (ADR-0073 §1, the former «Я» tab; the fifth tab, my avatar): the profile card (avatar, name, status — the status menu on tap), the
 * microphone and the sound with their device menus (the self panel's, the desktop's bottom
 * island is not shown on a phone), the settings entries (each opens the settings at its section,
 * as the gear did) and «Выйти».
 */
export function PhoneProfile(): ReactNode {
  const user = useSession((s) => s.me?.user);
  const local = useSession((s) => localAuthority(s.authority));
  const guest = useSession((s) => s.me?.user?.isGuest === true);
  const superadmin = useSession((s) => s.me?.isSuperadmin === true);
  const open = useUi((s) => s.openDialog);
  const status = useMyStatus();
  useCustomStatusExpiry();
  if (!user) return null;
  const statusName = t(STATUS_KEY[status] ?? 'presence.online');
  const custom = [user.statusEmoji, user.statusText].filter(Boolean).join(' ');
  const entries: Array<{ id: string; label: MessageKey; icon: LucideIcon; show: boolean }> = [
    { id: 'general', label: 'settings.general', icon: SlidersHorizontal, show: true },
    { id: 'profile', label: 'settings.profile', icon: CircleUser, show: local },
    { id: 'voice', label: 'settings.voice', icon: Mic, show: true },
    { id: 'notifications', label: 'settings.notifications', icon: Bell, show: true },
    { id: 'calendar', label: 'settings.calendar', icon: CalendarDays, show: local && !guest },
    { id: 'connection', label: 'settings.connection', icon: Wifi, show: true },
    { id: 'sessions', label: 'settings.sessions', icon: MonitorSmartphone, show: local },
    { id: 'about', label: 'settings.about', icon: Info, show: true },
  ];
  const preload = (): void => void AppSettingsWindow.preload();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4" data-testid="phone-profile">
      <StatusMenu>
        <button
          type="button"
          aria-label={`${t('shell.profile')}: ${user.displayName}, ${statusName}`}
          className="flex w-full min-w-0 items-center gap-4 rounded-[var(--radius-panel)] bg-[var(--color-fill)] p-4 text-left active:bg-[var(--color-fill-hover)] data-[state=open]:bg-[var(--color-fill-hover)]"
          data-testid="phone-profile-card"
        >
          <Avatar userId={user.id} name={user.displayName} fileId={user.avatarFileId || undefined} size={64} status={status} ring="var(--color-bg)" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="line-clamp-2 break-words text-headline font-semibold">{user.displayName}</span>
            {/* The nickname (ADR-0077). */}
            {user.username ? <span className="truncate text-body text-muted">@{user.username}</span> : null}
            <span className="fade-end overflow-hidden whitespace-nowrap text-body text-muted">{custom || statusName}</span>
          </span>
          <ChevronDown className="size-5 shrink-0 text-muted" aria-hidden />
        </button>
      </StatusMenu>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <MicTile />
        <SoundTile />
      </div>

      <h2 className="mb-1 mt-6 px-1 text-micro font-semibold uppercase tracking-[0.04em] text-muted">{t('settings.title')}</h2>
      <ul className="overflow-hidden rounded-[var(--radius-panel)] bg-[var(--color-fill)]">
        {entries
          .filter((e) => e.show)
          .map((e) => (
            <li key={e.id} className="border-b border-line last:border-b-0">
              <button
                type="button"
                onPointerDown={preload}
                onClick={() => open({ kind: 'settings', tab: e.id })}
                className="flex h-12 w-full min-w-0 items-center gap-3 px-4 text-left text-list active:bg-[var(--color-fill-hover)]"
                data-testid={`phone-profile-${e.id}`}
              >
                <e.icon className="size-5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t(e.label)}</span>
                <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
              </button>
            </li>
          ))}
        {superadmin ? (
          <li className="border-b border-line last:border-b-0">
            <button type="button" onClick={() => open({ kind: 'admin' })} className="flex h-12 w-full min-w-0 items-center gap-3 px-4 text-left text-list active:bg-[var(--color-fill-hover)]">
              <ShieldCheck className="size-5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t('admin.title')}</span>
              <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
            </button>
          </li>
        ) : null}
      </ul>

      <button
        type="button"
        onClick={() => void logout()}
        className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-panel)] bg-[var(--color-fill)] text-list font-medium text-danger-text active:bg-[var(--color-fill-hover)]"
        data-testid="phone-profile-logout"
      >
        <LogOut className="size-5" aria-hidden />
        {t('settings.logout')}
      </button>
    </div>
  );
}

// pl-3 / gap-2: at 375 px a half-width tile next to its 44 px ▾ leaves ~79 px for the title — «Микрофон»
// fits whole (with pl-4 / gap-3 it was cut to «Микро…»).
const tile = 'flex h-16 min-w-0 flex-1 items-center gap-2 rounded-l-[var(--radius-panel)] pl-3 text-left';

/** Microphone: the tile toggles mute, ▾ opens the mode and the input devices (the self panel's menu). */
function MicTile(): ReactNode {
  const muted = useVoice((s) => s.muted);
  const serverMuted = useVoice((s) => s.serverMuted);
  const label = serverMuted ? t('voiceUi.serverMuted') : muted ? t('voice.unmute') : t('voice.mute');
  return (
    <DeviceTile
      icon={muted ? MicOff : Mic}
      off={muted}
      title={t('mobile.mic')}
      state={muted ? t('mobile.off') : t('mobile.on')}
      label={label}
      onToggle={() => voice.toggleMute()}
      menuLabel={t('shell.micOptions')}
      menu={<MicMenu />}
      testId="phone-profile-mic"
    />
  );
}

/** Sound: the tile toggles deafen, ▾ opens the output devices and the volume. */
function SoundTile(): ReactNode {
  const deafened = useVoice((s) => s.deafened);
  return (
    <DeviceTile
      icon={deafened ? HeadphoneOff : Headphones}
      off={deafened}
      title={t('mobile.sound')}
      state={deafened ? t('mobile.off') : t('mobile.on')}
      label={deafened ? t('voice.undeafen') : t('voice.deafen')}
      onToggle={() => voice.toggleDeafen()}
      menuLabel={t('shell.outputOptions')}
      menu={<DeviceMenu kind="audiooutput" />}
      testId="phone-profile-sound"
    />
  );
}

function DeviceTile({
  icon: Icon,
  off,
  title,
  state,
  label,
  onToggle,
  menuLabel,
  menu,
  testId,
}: {
  icon: LucideIcon;
  off: boolean;
  title: string;
  state: string;
  label: string;
  onToggle: () => void;
  menuLabel: string;
  menu: ReactNode;
  testId: string;
}): ReactNode {
  return (
    <div className={cx('flex min-w-0 rounded-[var(--radius-panel)]', off ? 'bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)]' : 'bg-[var(--color-fill)]')}>
      <button type="button" aria-label={label} aria-pressed={off} onClick={onToggle} className={tile} data-testid={testId}>
        <Icon className={cx('size-6 shrink-0', off ? 'text-danger' : 'text-fg')} aria-hidden />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-list font-medium">{title}</span>
          <span className={cx('truncate text-caption', off ? 'text-danger-text' : 'text-muted')}>{state}</span>
        </span>
      </button>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" aria-label={menuLabel} className="grid w-11 shrink-0 place-items-center rounded-r-[var(--radius-panel)] text-muted data-[state=open]:text-fg">
            <ChevronDown className="size-4" aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>{menu}</Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}


/** The icon of the «Профиль» tab: my avatar with the presence dot (ring marks the open tab). */
export function ProfileTabIcon({ active }: { active: boolean }): ReactNode {
  const user = useSession((s) => s.me?.user);
  const status = useMyStatus();
  // A 28 px box like the other tab icons (size-7): the 22 px avatar centred in it keeps the label
  // on the same baseline as its neighbours.
  if (!user) return <span className="flex size-7 items-center justify-center"><CircleUser className="size-[22px]" strokeWidth={1.75} aria-hidden /></span>;
  return (
    <span className="flex size-7 items-center justify-center">
      <span className={cx('flex size-[22px] rounded-full ring-2 ring-offset-0', active ? 'ring-fg' : 'ring-transparent')}>
        <Avatar userId={user.id} name={user.displayName} fileId={user.avatarFileId || undefined} size={22} status={status} ring="var(--color-toolbar,var(--color-bg))" />
      </span>
    </span>
  );
}

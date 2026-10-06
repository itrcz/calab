import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { HeadphoneOff, Headphones, LogOut, Mic, MicOff, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { t } from '../../i18n';
import { useHotkeyLabel } from '../../services/hotkeys';
import { logout } from '../../services/session';
import { voice } from '../../services/voice';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { AppSettingsWindow } from './lazyWindows';
import { menuItem, menuSeparator } from './menu';
import { DeviceMenu, MicMenu, SplitButton } from './SelfPanel';
import { STATUS_KEY, StatusMenu, useCustomStatusExpiry, useMyStatus } from './StatusMenu';

/**
 * My avatar at the foot of the sections rail (docs/08 «Профиль на рейле», owner 07.10, Codex
 * reference) — in place of the always-on self panel. The presence dot on the avatar; a red mark
 * while my mic or sound is off. A click opens the profile menu: the status menu (presence, custom
 * status, «Редактировать профиль») with the mic ▾ / sound ▾ controls under the header — the
 * defaults before a call, the same toggles as the hotkeys — and «Настройки», «Выйти» at the end.
 * In a call the column's call panel carries mic and sound too. A leaf: primitive selectors only.
 */
export function RailProfile(): ReactNode {
  const id = useSession((s) => s.me?.user?.id ?? '');
  const name = useSession((s) => s.me?.user?.displayName ?? '');
  const fileId = useSession((s) => s.me?.user?.avatarFileId ?? '');
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const speaking = useVoice((s) => (id ? (s.speaking[id] ?? false) : false));
  const inVoice = useVoice((s) => s.roomId !== null);
  const status = useMyStatus();
  useCustomStatusExpiry();
  if (!id) return null;
  const statusName = t(STATUS_KEY[status] ?? 'presence.online');
  const off = deafened || muted;
  return (
    <StatusMenu side="right" align="end" compact top={<ProfileVoice />} bottom={<ProfileFooter />}>
      <button
        type="button"
        aria-label={`${t('shell.profile')}: ${name}, ${statusName}${inVoice ? `, ${t('shell.inVoiceStatus')}` : ''}`}
        data-testid="rail-profile"
        className="relative grid size-10 shrink-0 place-items-center rounded-full transition-colors duration-[var(--motion-fast)] hover:bg-active data-[state=open]:bg-hover"
      >
        <Avatar userId={id} name={name} fileId={fileId || undefined} size={32} speaking={speaking && !muted} status={status} ring="var(--color-rail)" />
        {off ? (
          <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-danger-fill text-white ring-2 ring-[var(--color-rail)]" data-testid="rail-profile-off" aria-hidden>
            {deafened ? <HeadphoneOff className="size-2.5" strokeWidth={2.5} /> : <MicOff className="size-2.5" strokeWidth={2.5} />}
          </span>
        ) : null}
      </button>
    </StatusMenu>
  );
}

/** Mic ▾ and sound ▾ (the former self panel's controls) on one row under the menu header. */
function ProfileVoice(): ReactNode {
  const muted = useVoice((s) => s.muted);
  const serverMuted = useVoice((s) => s.serverMuted);
  const deafened = useVoice((s) => s.deafened);
  const muteKeys = useHotkeyLabel('mute');
  const deafenKeys = useHotkeyLabel('deafen');
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1.5" data-testid="profile-voice">
      <span className="min-w-0 flex-1 truncate text-caption text-muted">{t('settings.voice')}</span>
      <SplitButton
        label={serverMuted ? t('voiceUi.serverMuted') : muted ? t('voice.unmute') : t('voice.mute')}
        shortcut={muteKeys}
        danger={muted}
        onClick={() => voice.toggleMute()}
        menuLabel={t('shell.micOptions')}
        menu={<MicMenu />}
      >
        {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
      </SplitButton>
      <SplitButton
        label={deafened ? t('voice.undeafen') : t('voice.deafen')}
        shortcut={deafenKeys}
        danger={deafened}
        onClick={() => voice.toggleDeafen()}
        menuLabel={t('shell.outputOptions')}
        menu={<DeviceMenu kind="audiooutput" />}
      >
        {deafened ? <HeadphoneOff className="size-5" /> : <Headphones className="size-5" />}
      </SplitButton>
    </div>
  );
}

function ProfileFooter(): ReactNode {
  const preload = (): void => void AppSettingsWindow.preload();
  return (
    <>
      <Dropdown.Separator className={menuSeparator} />
      <Dropdown.Item className={menuItem} onPointerEnter={preload} onFocus={preload} onSelect={() => useUi.getState().openDialog({ kind: 'settings' })} data-testid="profile-settings">
        <Settings className="size-4" aria-hidden /> {t('settings.title')}
      </Dropdown.Item>
      <Dropdown.Item className={menuItem} onSelect={() => void logout()} data-testid="profile-logout">
        <LogOut className="size-4" aria-hidden /> {t('settings.logout')}
      </Dropdown.Item>
    </>
  );
}

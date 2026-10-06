import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Settings } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { IconButton, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { PttLastKey, bindingLabel, usePttCapture, type PttCapture } from '../settings/PttBinder';
import { PttReleaseDelay } from '../settings/PttReleaseDelay';
import { menuBox, menuItem, menuLabel, menuSeparator } from './menu';
import { MenuSliderItem } from './MenuSliderItem';
import { selectMicMode, swallowMenuKey } from './micMenu';

/*
 * The voice controls of the former self panel (docs/09 #6, #28): the mic / sound split buttons and
 * their device menus. The desktop shows them in the rail's profile menu (RailProfile) and the call
 * panel (VoiceBar); the phone in «Профиль» (PhoneProfile). The panel itself left the sidebar
 * (owner, 07.10).
 */

/** Icon button + ▾ device picker, one hover group (Discord-like). */
export function SplitButton({
  label,
  shortcut,
  danger,
  onClick,
  menuLabel: menuName,
  menu,
  children,
}: {
  label: string;
  shortcut: string;
  danger: boolean;
  onClick: () => void;
  menuLabel: string;
  menu: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    // One 44 px split control (Discord): the 20 px icon and the ▾ next to it share one hover pill, 6 px
    // inside it on both ends (docs/09 #102); the ▾ is always visible — the device menu is one click away.
    // Keyboard focus: one ring around the whole pill (a half-pill outline reads as broken, docs/09
    // #138); the focused half takes the stronger fill so it's clear which one Enter presses.
    <div className="group/split flex h-8 shrink-0 items-center rounded-[var(--radius-icon)] outline-offset-2 outline-focus transition-colors duration-[var(--motion-fast)] hover:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-solid" data-focus-box>
      <IconButton label={label} shortcut={shortcut} danger={danger} onClick={onClick} className="h-8 w-[26px] rounded-r-none pl-1.5 hover:bg-transparent focus-visible:bg-[var(--color-fill-hover)] focus-visible:outline-none">
        {children}
      </IconButton>
      <Dropdown.Root modal={false}>
        <Tip label={menuName}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            aria-label={menuName}
            className="grid h-8 w-[18px] place-items-center rounded-r-[var(--radius-icon)] pl-0.5 pr-1.5 text-muted transition-colors duration-[var(--motion-fast)] hover:text-fg focus-visible:bg-[var(--color-fill-hover)] focus-visible:text-fg focus-visible:outline-none data-[state=open]:text-fg"
          >
            <ChevronDown className="size-2.5 shrink-0" strokeWidth={2.75} aria-hidden />
          </button>
        </Dropdown.Trigger>
        </Tip>
        <Dropdown.Portal>{menu}</Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}

const DEFAULT_ID = '__default__';

/**
 * Mic ▾ (docs/09 #28): «Режим» on top — voice activation (+ threshold) / push-to-talk (+ the key,
 * captured right in the menu, and the release delay) — then the input devices and «Настройки
 * голоса». While a key capture is armed the menu stays open (Esc cancels the capture, a click
 * outside is ignored) and keys go to the capture, not to the menu's typeahead / items.
 */
export function MicMenu(): ReactNode {
  const cap = usePttCapture();
  const endedAt = useRef(0);
  const wasCapturing = useRef(false);
  useEffect(() => {
    if (wasCapturing.current && !cap.capturing) endedAt.current = Date.now();
    wasCapturing.current = cap.capturing;
  }, [cap.capturing]);
  const hold = (e: Event): void => {
    if (cap.capturing) e.preventDefault();
  };
  return (
    <DeviceMenu
      kind="audioinput"
      top={<MicModeSection cap={cap} />}
      testId="mic-menu"
      contentProps={{
        onEscapeKeyDown: (e) => {
          if (!cap.capturing) return;
          e.preventDefault();
          cap.cancel();
        },
        onPointerDownOutside: hold,
        onFocusOutside: hold,
        onInteractOutside: hold,
        onKeyDownCapture: (e) => {
          if (e.key !== 'Escape' && swallowMenuKey(cap.capturing, endedAt.current, Date.now())) e.preventDefault();
        },
      }}
    />
  );
}

/** Mic ▾ «Режим»: two radio items, then the chosen mode's controls. */
function MicModeSection({ cap }: { cap: PttCapture }): ReactNode {
  // A one-to-one call is voice activation only (ADR-0034): PTT off until it ends.
  const call = useVoice((s) => s.call);
  const chosen = usePrefs((s) => s.micMode);
  const micMode = call ? 'voice' : chosen;
  const threshold = usePrefs((s) => s.thresholdDb);
  const binding = usePrefs((s) => s.pttBinding);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const os = useSession((s) => s.appInfo?.platform ?? 'web');
  const radio = cx(menuItem, 'relative pl-7');
  return (
    <>
      <Dropdown.Label className={menuLabel}>{t('shell.micMode')}</Dropdown.Label>
      {call ? <div className="px-2 pb-1 text-caption text-muted">{t('call.voiceOnly')}</div> : null}
      <Dropdown.RadioGroup value={micMode} onValueChange={selectMicMode}>
        {/* Selecting a mode keeps the menu open: its controls appear right below. */}
        <Dropdown.RadioItem value="voice" className={radio} onSelect={(e) => e.preventDefault()} data-testid="mic-mode-voice">
          <Dropdown.ItemIndicator className="absolute left-2">
            <Check className="size-3.5" />
          </Dropdown.ItemIndicator>
          {t('shell.micModeVoice')}
        </Dropdown.RadioItem>
        <Dropdown.RadioItem value="ptt" className={radio} disabled={call} onSelect={(e) => e.preventDefault()} data-testid="mic-mode-ptt">
          <Dropdown.ItemIndicator className="absolute left-2">
            <Check className="size-3.5" />
          </Dropdown.ItemIndicator>
          {t('voice.modePtt')}
        </Dropdown.RadioItem>
      </Dropdown.RadioGroup>
      {micMode === 'voice' ? (
        <MenuSliderItem
          label={t('shell.inputVolume')}
          valueText={t('unit.db', { n: threshold })}
          value={threshold}
          min={-80}
          max={-10}
          onChange={(v) => setPrefs({ thresholdDb: v })}
        />
      ) : (
        <>
          {/* The key as a pill; the row (or Enter on it) arms the capture in place. */}
          <Dropdown.Item
            className={cx(menuItem, 'group/key h-8 justify-between pl-7')}
            onSelect={(e) => {
              e.preventDefault();
              if (!cap.capturing) void cap.bind();
            }}
            aria-label={cap.capturing ? t('voice.pttPress') : `${t('voice.pttKey')}: ${bindingLabel(binding, os)}. ${t('shell.pttChange')}`}
            data-testid="mic-ptt-key"
            data-capturing={cap.capturing || undefined}
          >
            <kbd
              className={cx(
                'min-w-0 truncate rounded-[var(--radius-control)] border px-2.5 py-px font-sans text-caption',
                cap.capturing ? 'border-accent text-fg' : 'border-line bg-elev text-fg',
              )}
            >
              {cap.capturing ? t('voice.pttPress') : bindingLabel(binding, os)}
            </kbd>
            <span className="shrink-0 text-caption text-muted group-data-[highlighted]/key:text-accent-fg">
              {cap.capturing ? t('shell.pttEscCancel') : t('shell.pttChange')}
            </span>
          </Dropdown.Item>
          {cap.lastKey ? (
            <div className="px-2 pl-7">
              <PttLastKey lastKey={cap.lastKey} os={os} />
            </div>
          ) : null}
          <PttReleaseDelay compact />
        </>
      )}
      <Dropdown.Separator className={menuSeparator} />
    </>
  );
}

type ContentProps = ComponentPropsWithoutRef<typeof Dropdown.Content>;

/** Device quick-picker: list of inputs/outputs (the mic menu puts «Режим» on top). */
export function DeviceMenu({
  kind,
  top,
  testId,
  contentProps,
}: {
  kind: 'audioinput' | 'audiooutput';
  top?: ReactNode;
  testId?: string;
  contentProps?: Pick<ContentProps, 'onEscapeKeyDown' | 'onPointerDownOutside' | 'onFocusOutside' | 'onInteractOutside' | 'onKeyDownCapture'>;
}): ReactNode {
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const micId = usePrefs((s) => s.micDeviceId);
  const outId = usePrefs((s) => s.outputDeviceId);
  const outputVolume = usePrefs((s) => s.outputVolume);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const open = useUi((s) => s.openDialog);
  const current = (kind === 'audioinput' ? micId : outId) ?? DEFAULT_ID;
  // Mounted only while the menu is open: enumerate then (labels need the mic permission).
  useEffect(() => {
    let alive = true;
    void navigator.mediaDevices.enumerateDevices().then(
      (d) => {
        if (alive) setDevices(d);
      },
      () => {
        if (alive) setDevices([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const list = (devices ?? []).filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const select = (id: string): void => {
    const v = id === DEFAULT_ID ? null : id;
    setPrefs(kind === 'audioinput' ? { micDeviceId: v } : { outputDeviceId: v });
  };
  return (
    <Dropdown.Content
      className={cx(menuBox, 'w-72')}
      side="top"
      align="end"
      sideOffset={6}
      collisionPadding={16}
      data-testid={testId}
      {...contentProps}
    >
      {top}
      <Dropdown.Label className={menuLabel}>{kind === 'audioinput' ? t('shell.inputDevice') : t('shell.outputDevice')}</Dropdown.Label>
      <Dropdown.RadioGroup value={current} onValueChange={select}>
        <Dropdown.RadioItem value={DEFAULT_ID} className={cx(menuItem, 'relative pl-7')}>
          <Dropdown.ItemIndicator className="absolute left-2">
            <Check className="size-3.5" />
          </Dropdown.ItemIndicator>
          <span className="truncate">{t('shell.systemDefault')}</span>
        </Dropdown.RadioItem>
        {list.map((d) => (
          <Dropdown.RadioItem key={d.deviceId} value={d.deviceId} className={cx(menuItem, 'relative pl-7')} title={d.label}>
            <Dropdown.ItemIndicator className="absolute left-2">
              <Check className="size-3.5" />
            </Dropdown.ItemIndicator>
            <span className="truncate">{d.label || d.deviceId.slice(0, 8)}</span>
          </Dropdown.RadioItem>
        ))}
      </Dropdown.RadioGroup>
      {devices !== null && list.length === 0 ? <div className="px-2 py-1 text-caption text-muted">{t('shell.noDevices')}</div> : null}
      {kind === 'audiooutput' ? (
        <>
          <Dropdown.Separator className={menuSeparator} />
          {/* element.volume only (no WebAudio, docs/02 echo rule 1): 100 % is the maximum. */}
          <MenuSliderItem
            label={t('shell.outputVolume')}
            valueText={`${Math.round(outputVolume * 100)}%`}
            value={Math.round(outputVolume * 100)}
            min={0}
            max={100}
            onChange={(v) => setPrefs({ outputVolume: v / 100 })}
          />
        </>
      ) : null}
      <Dropdown.Separator className={menuSeparator} />
      <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'settings', tab: 'voice' })}>
        <Settings className="size-4" /> {t('shell.voiceSettings')}
      </Dropdown.Item>
    </Dropdown.Content>
  );
}

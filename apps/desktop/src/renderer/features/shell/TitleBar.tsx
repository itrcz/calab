import * as Popover from '@radix-ui/react-popover';
import { CircleHelp, Search, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { shortcutHelp, useHotkeyLabel } from '../../services/hotkeys';
import { platform } from '../../platform';
import { usePrefs } from '../../stores/prefs';
import { HOME } from '../../stores/dms';
import { selectUpdatePending, useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { titleSlot } from '../../lib/webApps';
import { useOpenApp, useWebApps } from '../../stores/webApps';
import { bindingLabel } from '../settings/PttBinder';
import { popoverBox } from './menu';
import { AppSettingsWindow } from './lazyWindows';
import { InboxButton } from './InboxPopover';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { PlanBadge } from '../workspace/billing/PlanBadge';

/**
 * Window title bar (docs/09 #1; owner 07.10 — a taller, airier bar): 46 px across the whole window,
 * drag region in Electron. Left: only Electron on macOS keeps 80 px empty for the traffic lights
 * (hiddenInset at 16,16 — centred in the bar); the web and Windows / Linux start at the normal
 * 8 px padding. Then the current workspace's name with «⌄» — the workspace switcher (ADR-0074 §2;
 * it replaced the «‹ ›» history buttons, whose shortcuts stay); «Calab ⌄» before any workspace
 * exists. No room / chat title here (owner, 07.10).
 * Right: search (opens the quick switcher), mentions, settings, shortcuts help — quiet; on Windows
 * the native caption buttons (Window Controls Overlay) take the space given by env(titlebar-area-*).
 * Web (docs/09 #46): a 38 px toolbar — no window chrome, so no reserved inset and no drag region.
 */
export function TitleBar(): ReactNode {
  const os = useSession((s) => s.appInfo?.platform);
  const electron = platform.kind === 'electron';
  const web = !electron;
  const mac = electron && os === 'darwin';
  const searchKeys = useHotkeyLabel('search');
  const open = useUi((s) => s.openDialog);

  return (
    <header
      aria-label={t('shell.titlebar')}
      className={cx(
        'mat-rail relative z-[var(--z-sticky)] flex shrink-0 items-center gap-3',
        web ? 'h-[var(--titlebar-height-web)]' : 'h-[var(--titlebar-height)]',
        electron && 'drag',
      )}
      data-testid="titlebar"
      data-variant={web ? 'web' : 'window'}
      // Windows (WCO): keep clear of the native caption buttons; 0 elsewhere (none on the web).
      style={web ? undefined : { paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))' }}
    >
      <div className={cx('flex min-w-0 items-center', !mac && 'pl-2')}>
        {/* macOS traffic lights live here — nothing is drawn under them (Electron on macOS only). */}
        {mac ? <div className="w-[80px] shrink-0" aria-hidden /> : null}
        <TitleBarWorkspace />
      </div>

      <div className="ml-auto flex min-w-0 items-center justify-end gap-1 pr-2">
        {/* The one workspace search entry point (docs/09 #53): always shown. */}
        <button
          type="button"
          onClick={() => open({ kind: 'quick-switcher' })}
          aria-label={t('shell.search')}
          // Quiet (owner, 07.10): a hairline pill, the fill only on hover.
          className="flex h-7 w-[clamp(120px,14vw,200px)] min-w-0 items-center gap-1.5 rounded-[var(--radius-icon)] border border-line px-2.5 text-caption text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg"
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">{t('shell.search')}</span>
          <kbd className="shrink-0 font-sans text-micro text-muted">
            {searchKeys}
          </kbd>
        </button>
        <InboxButton />
        <SettingsButton />
        <HelpButton />
      </div>
    </header>
  );
}

/**
 * The workspace switcher (ADR-0074 §2; its own leaf), or the name of a web app that fills the
 * screen (ADR-0050 «Уточнение»: plain text, no menu — the rail's sections lead back).
 */
function TitleBarWorkspace(): ReactNode {
  const wsId = useUi((s) => s.activeWorkspaceId);
  const openId = useOpenApp(wsId && wsId !== HOME ? wsId : null);
  const appName = useWebApps((s) => (openId ? s.byId[openId]?.name : undefined));
  const slot = titleSlot(appName);
  if (slot.kind === 'app') {
    return (
      <div className="max-w-[220px] truncate px-2 text-body font-semibold text-fg" title={slot.text} data-testid="titlebar-title" data-app="">
        {slot.text}
      </div>
    );
  }
  return (
    <>
      <WorkspaceSwitcher testId="titlebar-title" />
      {/* The plan badge (ADR-0080): only where billing exists for this workspace; renders nothing otherwise. */}
      <PlanBadge />
    </>
  );
}

/**
 * The gear; an accent dot while an update waits (docs/09 #125) — a click then opens «О программе».
 * Its own leaf: the boolean selector re-renders only the button.
 */
function SettingsButton(): ReactNode {
  const open = useUi((s) => s.openDialog);
  const update = useSession(selectUpdatePending);
  return (
    <IconButton
      bar
      label={update ? t('update.settingsDot') : t('settings.title')}
      onPointerEnter={() => void AppSettingsWindow.preload()}
      onFocus={() => void AppSettingsWindow.preload()}
      onClick={() => open(update ? { kind: 'settings', tab: 'about' } : { kind: 'settings' })}
      className="relative size-7"
    >
      <Settings className="size-[18px]" />
      {update ? <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-accent ring-2 ring-[var(--color-rail)]" data-testid="settings-update-dot" aria-hidden /> : null}
    </IconButton>
  );
}

// ---------------------------------------------------------------- shortcuts help

function HelpButton(): ReactNode {
  const binding = usePrefs((s) => s.pttBinding);
  const os = useSession((s) => s.appInfo?.platform ?? '');
  const open = useUi((s) => s.openDialog);
  const rows = [...shortcutHelp().map((r) => ({ keys: r.keys, label: t(r.label) })), { keys: binding ? bindingLabel(binding, os) : t('shell.kbd.pttNone'), label: t('shell.kbd.ptt') }];
  return (
    <Popover.Root>
      <Tip label={t('shell.help')}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={t('shell.help')}
            className="grid size-7 place-items-center rounded-[var(--radius-bar)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"
          >
            <CircleHelp className="size-[18px]" aria-hidden />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={16} aria-label={t('shell.help')} className={cx(popoverBox, 'w-[300px] p-3')}>
          <div className="mb-2 text-body font-semibold">{t('shell.help')}</div>
          <dl className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3">
                <dt className="min-w-0 truncate text-body text-muted">{r.label}</dt>
                <dd className="shrink-0">
                  <kbd className="rounded-[4px] border border-line bg-hover px-1.5 py-px font-sans text-caption text-fg">{r.keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
          <Popover.Close asChild>
            <button type="button" onClick={() => open({ kind: 'settings', tab: 'hotkeys' })} className="mt-3 text-caption text-accent-text hover:underline">
              {t('shell.kbd.settings')}
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

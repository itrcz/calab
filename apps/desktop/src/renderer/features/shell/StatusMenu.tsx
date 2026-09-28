import { timestampMs } from '@bufbuild/protobuf/wkt';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { PresenceStatus } from '@calaba/protocol';
import { Check, ChevronRight, Pencil, Smile, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Avatar, StatusGlyph } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { fmt } from '../../lib/format';
import { AFTER_SHORT, STATUS_PRESETS, applyCustomStatus, saveCustomStatus, type StatusChoice } from '../../services/customStatus';
import { PRESENCE_DURATIONS, choosePresence } from '../../services/presenceTimer';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { CustomStatusDialog } from './CustomStatusDialog';
import { menuBox, menuItem, menuLabel, menuSeparator } from './menu';

export const STATUS_KEY: Record<number, MessageKey> = {
  [PresenceStatus.ONLINE]: 'presence.online',
  [PresenceStatus.IDLE]: 'presence.idle',
  [PresenceStatus.DND]: 'presence.dnd',
  [PresenceStatus.INVISIBLE]: 'presence.invisible',
};

/** Timed statuses with a duration submenu, and their second line (Discord). */
const TIMED: Array<{ s: PresenceStatus; hint?: MessageKey }> = [
  { s: PresenceStatus.IDLE },
  { s: PresenceStatus.DND, hint: 'presence.dndHint' },
  { s: PresenceStatus.INVISIBLE, hint: 'presence.invisibleHint' },
];

/** The surface the menu glyphs sit on (their cutouts). */
const MENU_SURFACE = 'var(--color-popover-solid)';

/** What others see: my manual choice, or the server's aggregate (AFK idle) while «online». */
export function useMyStatus(): PresenceStatus {
  const chosen = usePrefs((s) => s.presence);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const server = useWorkspaces((s) => s.presences[me]?.status);
  if (chosen !== PresenceStatus.ONLINE) return chosen;
  return server === PresenceStatus.IDLE ? PresenceStatus.IDLE : PresenceStatus.ONLINE;
}

/** «до 18:30» today, «до 30 сент., 18:30» later. */
function untilLabel(until: number): string {
  return t('presence.until', { time: fmt.until(new Date(until)) });
}

/** «Свой статус» one-click rows: the presets, then my recent statuses — minus the one I have now. */
function customChoices(recent: readonly StatusChoice[], current: { emoji: string; text: string }): Array<StatusChoice & { id: string }> {
  const isCurrent = (c: { emoji: string; text: string }): boolean => !!current.text && c.text === current.text && c.emoji === current.emoji;
  const presets = STATUS_PRESETS.map((p) => ({ id: p.id, emoji: p.emoji, text: t(p.key), after: p.after }));
  const mine = recent.map((r, i) => ({ ...r, id: `recent-${i}` }));
  return [...presets, ...mine].filter((c) => !isCurrent(c));
}

/**
 * Status menu (docs/09 #29, Discord reference `discord-status-menu.png`): a click on my avatar /
 * name in the self panel. «В сети» | «Не активен» › · «Не беспокоить» › · «Невидимый» › with
 * durations (15 минут … Навсегда; a plain click on the row = «Навсегда») | «Свой статус»: the
 * current one (click = edit, × = clear), presets and up to 3 recent ones (one click), «Задать
 * свой…» | «Редактировать профиль» (+ admin).
 */
export function StatusMenu({ children }: { children: ReactNode }): ReactNode {
  const me = useSession((s) => s.me);
  const chosen = usePrefs((s) => s.presence);
  const until = usePrefs((s) => s.presenceUntil);
  const recent = usePrefs((s) => s.recentStatuses);
  const openDialog = useUi((s) => s.openDialog);
  const status = useMyStatus();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const user = me?.user;
  if (!user) return null;
  const customText = [user.statusEmoji, user.statusText].filter(Boolean).join(' ');
  const customUntil = user.statusText && user.statusExpiresAt ? timestampMs(user.statusExpiresAt) : null;
  const choices = customChoices(recent, { emoji: user.statusEmoji, text: user.statusText });
  const pick = (s: PresenceStatus, ms: number | null = null): void => {
    choosePresence(s, ms);
    setOpen(false);
  };
  const row = cx(menuItem, 'h-auto min-h-8 py-1.5');
  const caption = (s: PresenceStatus): string | null => {
    if (chosen !== s) return null;
    if (until !== null) return untilLabel(until);
    return null;
  };

  return (
    <>
      <Dropdown.Root modal={false} open={open} onOpenChange={setOpen}>
        <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={16}
            aria-label={t('presence.change')}
            data-testid="status-menu"
            className={cx(menuBox, 'max-h-[var(--radix-dropdown-menu-content-available-height)] w-[280px] overflow-y-auto')}
            onCloseAutoFocus={(e) => {
              if (custom) e.preventDefault(); // the custom status sheet takes the focus
            }}
          >
            <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
              <Avatar userId={user.id} name={user.displayName} fileId={user.avatarFileId || undefined} size={40} status={status} ring={MENU_SURFACE} />
              <span className="min-w-0">
                <span className="block truncate text-list font-semibold" title={user.displayName}>
                  {user.displayName}
                </span>
                <span className="block truncate text-caption text-muted">{me.email}</span>
              </span>
            </div>
            <Dropdown.Separator className={menuSeparator} />

            <Dropdown.Item className={row} onSelect={() => pick(PresenceStatus.ONLINE)} data-testid="status-online">
              <span className="grid w-4 place-items-center">
                <StatusGlyph status={PresenceStatus.ONLINE} ring={MENU_SURFACE} />
              </span>
              <span className="min-w-0 flex-1">
                {t('presence.online')}
                {/* «В сети» chosen, but the server made me idle (AFK): say why the dot is yellow. */}
                {chosen === PresenceStatus.ONLINE && status === PresenceStatus.IDLE ? (
                  <span className="block truncate text-caption opacity-70">{t('presence.autoIdle')}</span>
                ) : null}
              </span>
              {chosen === PresenceStatus.ONLINE ? <Check className="size-4" aria-hidden /> : null}
            </Dropdown.Item>
            <Dropdown.Separator className={menuSeparator} />

            {TIMED.map(({ s, hint }) => {
              const note = caption(s) ?? (hint ? t(hint) : null);
              return (
                <Dropdown.Sub key={s}>
                  <Dropdown.SubTrigger
                    className={cx(row, 'data-[state=open]:bg-[var(--color-fill-hover)]')}
                    data-testid={`status-${s}`}
                    // A mouse click on the row itself = «Навсегда» (Discord); touch opens the submenu.
                    onClick={(e) => {
                      if ((e.nativeEvent as PointerEvent).pointerType === 'mouse') pick(s);
                    }}
                  >
                    <span className="grid w-4 place-items-center self-start pt-[5px]">
                      <StatusGlyph status={s} ring={MENU_SURFACE} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{t(STATUS_KEY[s] ?? 'presence.online')}</span>
                      {note ? <span className="block truncate text-caption opacity-70">{note}</span> : null}
                    </span>
                    {chosen === s ? <Check className="size-4" aria-hidden /> : null}
                    <ChevronRight className="size-4 opacity-70" aria-hidden />
                  </Dropdown.SubTrigger>
                  <Dropdown.Portal>
                    <Dropdown.SubContent className={cx(menuBox, 'min-w-44')} sideOffset={6} alignOffset={-4} collisionPadding={16}>
                      {PRESENCE_DURATIONS.map((d) => (
                        <Dropdown.Item key={d.key} className={menuItem} onSelect={() => pick(s, d.ms)}>
                          {t(d.key)}
                        </Dropdown.Item>
                      ))}
                    </Dropdown.SubContent>
                  </Dropdown.Portal>
                </Dropdown.Sub>
              );
            })}
            <Dropdown.Separator className={menuSeparator} />

            <Dropdown.Label className={menuLabel}>{t('presence.customTitle')}</Dropdown.Label>
            {customText ? (
              <div className="flex items-center gap-1" data-testid="status-current">
                <Dropdown.Item
                  className={cx(row, 'min-w-0 flex-1')}
                  onSelect={() => setCustom(true)}
                  title={t('presence.editStatus')}
                  aria-label={`${t('presence.editStatus')}: ${customText}`}
                >
                  <span className="grid w-4 shrink-0 place-items-center text-[15px] leading-none" aria-hidden>
                    {user.statusEmoji || <Smile className="size-4 opacity-70" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{user.statusText}</span>
                    {customUntil !== null ? <span className="block truncate text-caption opacity-70">{untilLabel(customUntil)}</span> : null}
                  </span>
                </Dropdown.Item>
                <Dropdown.Item
                  className={cx(menuItem, 'w-7 shrink-0 justify-center px-0 text-muted')}
                  onSelect={() => void saveCustomStatus({ text: '', emoji: '', expiresInSeconds: 0 })}
                  aria-label={t('presence.clearStatus')}
                  title={t('presence.clearStatus')}
                  data-testid="status-clear"
                >
                  <X className="size-4" aria-hidden />
                </Dropdown.Item>
              </div>
            ) : null}
            {choices.map((c) => (
              <Dropdown.Item key={c.id} className={menuItem} onSelect={() => void applyCustomStatus(c)} data-testid={`status-choice-${c.id}`}>
                <span className="grid w-4 shrink-0 place-items-center text-[15px] leading-none" aria-hidden>
                  {c.emoji || <Smile className="size-4 opacity-70" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.text}</span>
                <span className="shrink-0 text-caption opacity-70">{t(AFTER_SHORT[c.after])}</span>
              </Dropdown.Item>
            ))}
            <Dropdown.Item className={menuItem} onSelect={() => setCustom(true)} data-testid="status-custom">
              <span className="grid w-4 shrink-0 place-items-center" aria-hidden>
                <Pencil className="size-3.5 opacity-70" />
              </span>
              {t('presence.custom')}
            </Dropdown.Item>
            <Dropdown.Separator className={menuSeparator} />
            <Dropdown.Item className={menuItem} onSelect={() => openDialog({ kind: 'settings', tab: 'profile' })}>
              {t('shell.editProfile')}
            </Dropdown.Item>
            {/* Product superadmin (SUPERADMIN_EMAILS, ADR-0024): plans of every workspace. */}
            {me.isSuperadmin ? (
              <Dropdown.Item className={menuItem} onSelect={() => openDialog({ kind: 'admin' })}>
                {t('admin.title')}
              </Dropdown.Item>
            ) : null}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {custom ? <CustomStatusDialog open onClose={() => setCustom(false)} /> : null}
    </>
  );
}

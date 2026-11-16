import { NotificationLevel } from '@calaba/protocol';
import * as ContextMenu from '../../components/radix/context-menu';
import * as Dropdown from '../../components/radix/dropdown-menu';
import { Bell, Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { t, type MessageKey } from '../../i18n';
import { fmt } from '../../lib/format';
import { menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { asEnum } from '../../lib/enums';

/** «До утра»: the next 08:00 local time (today before 8, else tomorrow). */
export function untilMorning(now = new Date()): number {
  const d = new Date(now);
  d.setHours(8, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** «Заглушить»: 1 ч · 8 ч · до утра; «навсегда» is level NONE without muted_until (docs/05). */
export const MUTES: ReadonlyArray<{ label: MessageKey; until: (now: Date) => number }> = [
  { label: 'chat.notifyMute1h', until: (now) => now.getTime() + 60 * 60_000 },
  { label: 'chat.notifyMute8h', until: (now) => now.getTime() + 8 * 60 * 60_000 },
  { label: 'chat.notifyMuteMorning', until: untilMorning },
];

export const LEVEL_LABEL: Partial<Record<NotificationLevel, MessageKey>> = {
  [NotificationLevel.ALL]: 'chat.notifyAll',
  [NotificationLevel.MENTIONS]: 'chat.notifyMentions',
  [NotificationLevel.NONE]: 'chat.notifyNone',
};

/** «Заглушено до 14:30». */
export const mutedText = (until: number): string => t('chat.notifyMutedUntil', { time: fmt.until(new Date(until)) });

export interface LevelOption {
  level: NotificationLevel;
  label: string;
}

/**
 * The body of a notification menu (room bell, workspace menu — docs/09 item 22): the level
 * radio group, then «Заглушить: 1 ч · 8 ч · до утра · навсегда», and «Включить уведомления»
 * while muted. Works inside a Dropdown or ContextMenu Content / SubContent (`kit`).
 */
export function NotifyMenuItems({
  kit = 'dropdown',
  title,
  options,
  value,
  mutedUntil,
  defaultLevel,
  note,
  onChange,
}: {
  title: string;
  options: LevelOption[];
  value: NotificationLevel;
  mutedUntil: number | null;
  /** What «Включить уведомления» restores after «навсегда» (level NONE). */
  defaultLevel: NotificationLevel;
  /** An extra line under the mute header (e.g. «Пространство заглушено до …»). */
  note?: string | undefined;
  onChange: (level: NotificationLevel, mutedUntil: number | null) => void;
  /** Which Radix menu hosts the items: a dropdown, or a context menu (the room row's, docs/09 #30). */
  kit?: 'dropdown' | 'context';
}): ReactNode {
  const M = kit === 'context' ? ContextMenu : Dropdown;
  return (
    <>
      <M.Label className={menuLabel}>{title}</M.Label>
      <M.RadioGroup value={String(value)} onValueChange={(v) => onChange(asEnum(NotificationLevel, Number(v)), mutedUntil)}>
        {options.map((o) => (
          <M.RadioItem key={o.level} value={String(o.level)} className={menuItem}>
            <span className="grid w-4 place-items-center">
              <M.ItemIndicator>
                <Check className="size-4" aria-hidden />
              </M.ItemIndicator>
            </span>
            <span className="truncate">{o.label}</span>
          </M.RadioItem>
        ))}
      </M.RadioGroup>
      <M.Separator className={menuSeparator} />
      <M.Label className={menuLabel}>{mutedUntil ? mutedText(mutedUntil) : t('chat.notifyMute')}</M.Label>
      {note ? <div className="px-2 pb-1 text-micro text-muted">{note}</div> : null}
      {MUTES.map((m) => (
        <M.Item key={m.label} className={menuItem} onSelect={() => onChange(value, m.until(new Date()))}>
          <span className="w-4" aria-hidden />
          {t(m.label)}
        </M.Item>
      ))}
      <M.Item className={menuItem} onSelect={() => onChange(NotificationLevel.NONE, null)}>
        <span className="w-4" aria-hidden />
        {t('chat.notifyMuteForever')}
      </M.Item>
      {mutedUntil || value === NotificationLevel.NONE ? (
        <>
          <M.Separator className={menuSeparator} />
          <M.Item
            className={menuItem}
            onSelect={() => onChange(value === NotificationLevel.NONE ? defaultLevel : value, null)}
          >
            <Bell className="size-4" aria-hidden /> {t('chat.notifyUnmute')}
          </M.Item>
        </>
      ) : null}
    </>
  );
}

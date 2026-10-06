import * as Popover from '@radix-ui/react-popover';
import { Car, Clock3, Hand, Heart, Leaf, Lightbulb, Pizza, Search, Smile, Trophy, type LucideIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { autoFocusAllowed } from '../../lib/mobile';
import { useChatView } from './chatView';
import { EMOJI_GROUPS, searchEmoji, typedEmoji } from './emoji';

const COLS = 9;

/** Category bar glyphs: monochrome, SF-Symbols-like (Telegram / macOS), not colour emoji. */
const GROUP_ICONS: Record<string, LucideIcon> = {
  smileys: Smile,
  people: Hand,
  nature: Leaf,
  food: Pizza,
  activity: Trophy,
  travel: Car,
  objects: Lightbulb,
  symbols: Heart,
};

/**
 * Lightweight emoji picker (no dependency): search by name, recent, 8 groups with a tab row.
 * Arrow keys move inside the grid (roving focus), Enter picks, Esc closes.
 */
export function EmojiPicker({
  onPick,
  label,
  children,
  onOpenChange,
  closeOnPick = false,
  canPick,
  hint,
  inModal = false,
  side,
  defaultOpen = false,
}: {
  onPick: (emoji: string) => void;
  label: string;
  children: ReactNode;
  /** Lets a host that shows the trigger only on hover keep it while the picker is open. */
  onOpenChange?: (open: boolean) => void;
  /** Reactions pick one emoji; the composer keeps the picker open for several. */
  closeOnPick?: boolean;
  /** Emojis that cannot be picked right now (reaction limit) are dimmed and ignored. */
  canPick?: (emoji: string) => boolean;
  /** A note above the grid, e.g. «Не больше 3 реакций на сообщение». */
  hint?: string | undefined;
  /**
   * Opened from a modal sheet («Свой статус»): the popover layer (--z-popover) sits under the
   * sheet's scrim (--z-modal) — shown off to the side, behind the scrim, and not clickable. Use
   * --z-modal-popover and open below the trigger (a field near the sheet's top edge has no room
   * above). Radix nests the layers: Esc and outside clicks close the picker only.
   */
  inModal?: boolean;
  /** Overrides the default side (e.g. a sticker's emoji chip in a modal opens the picker above it). */
  side?: 'top' | 'bottom';
  /** Opens on mount (a notes shelf's «Сменить эмодзи», ADR-0039). */
  defaultOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const change = (v: boolean): void => {
    setOpen(v);
    onOpenChange?.(v);
  };
  return (
    <Popover.Root open={open} onOpenChange={change} modal={false}>
      <Tip label={label}>
        <Popover.Trigger asChild>{children}</Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          side={side ?? (inModal ? 'bottom' : 'top')}
          align={inModal ? 'start' : 'end'}
          sideOffset={inModal ? 6 : 10}
          collisionPadding={16}
          aria-label={t('chat.emoji')}
          data-testid="emoji-picker"
          className={cx(
            'mat-popover dense anim-in flex h-[372px] w-[348px] mobile:h-[min(var(--phone-card-max-h),560px)] flex-col overflow-hidden rounded-[var(--radius-panel)]',
            // A short window: the grid shrinks to the room under the button (the picker scrolls anyway).
            inModal ? 'z-[var(--z-modal-popover)] max-h-[var(--radix-popover-content-available-height)]' : 'z-[var(--z-popover)]',
          )}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <PickerBody
            {...(canPick ? { canPick } : {})}
            {...(hint ? { hint } : {})}
            onPick={(e) => {
              if (canPick && !canPick(e)) return;
              useChatView.getState().pushRecent(e);
              onPick(e);
              if (closeOnPick) change(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PickerBody({ onPick, canPick, hint }: { onPick: (emoji: string) => void; canPick?: (emoji: string) => boolean; hint?: string }): ReactNode {
  const [q, setQ] = useState('');
  const recent = useChatView((s) => s.recentEmoji);
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  // The category under the top edge gets the underline in the bar.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    let cur: string | null = null;
    for (const sec of Array.from(el.querySelectorAll<HTMLElement>('section[data-group]'))) {
      if (sec.offsetTop - el.offsetTop <= el.scrollTop + 8) cur = sec.dataset['group'] ?? null;
    }
    setActive(cur);
  }, []);
  const sections = useMemo(() => {
    // A pasted / typed emoji (the OS emoji panel) is a result too: the manual-input fallback.
    if (q.trim()) return [{ id: 'search', label: t('chat.emojiFound'), list: [...new Set([...typedEmoji(q), ...searchEmoji(q)])] }];
    return [...(recent.length ? [{ id: 'recent', label: t('chat.emojiRecent'), list: recent }] : []), ...EMOJI_GROUPS.map((g) => ({ ...g, label: t(g.label) }))];
  }, [q, recent]);

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(scroller.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + step))];
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search className="size-4 shrink-0 text-faint" aria-hidden />
        <input
          // Phones: the grid first; the search field (and the keyboard) only on a tap.
          autoFocus={autoFocusAllowed()}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              scroller.current?.querySelector<HTMLButtonElement>('button[data-emoji]')?.focus();
            }
            // Enter picks the first result (a pasted emoji comes first).
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && q.trim()) {
              const first = sections[0]?.list[0];
              if (first) {
                e.preventDefault();
                onPick(first);
              }
            }
          }}
          placeholder={t('chat.emojiSearch')}
          aria-label={t('chat.emojiSearch')}
          className="h-10 min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-faint"
        />
      </div>
      {hint ? (
        <p role="status" data-testid="emoji-picker-hint" className="shrink-0 border-b border-line px-3 py-2 text-caption text-muted">
          {hint}
        </p>
      ) : null}
      {/* 12 px inset on both sides: 9 × 36 px cells fill the 348 px popover (narrower if a classic scrollbar takes room). */}
      <div ref={scroller} data-testid="emoji-picker-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2" onKeyDown={onGridKey} onScroll={onScroll}>
        {sections.map((s) => (
          <section key={s.id} id={`emoji-${s.id}`} data-group={s.id} aria-label={s.label} className="-mx-3 px-3">
            {/* The section bleeds into the scroller's 12 px padding, so the band spans the whole
                width without sticking out of its section; its text starts at the grid's inset. */}
            <h3 className="sticky top-0 z-[1] -mx-3 bg-[var(--color-popover-solid)] px-3 pb-1 pt-2 text-caption font-semibold text-muted">{s.label}</h3>
            {s.list.length === 0 ? <p className="px-1 py-4 text-center text-body text-muted">{t('chat.emojiNone')}</p> : null}
            <div className="grid grid-cols-9">
              {s.list.map((e, i) => {
                const blocked = canPick ? !canPick(e) : false;
                return (
                  <button
                    key={`${s.id}-${e}-${i}`}
                    type="button"
                    data-emoji
                    tabIndex={s === sections[0] && i === 0 ? 0 : -1}
                    onClick={() => onPick(e)}
                    aria-label={e}
                    aria-disabled={blocked || undefined}
                    className={cx(
                      'grid h-9 w-full min-w-0 place-items-center rounded-[var(--radius-row)] text-[22px] leading-none focus-visible:bg-hover focus-visible:outline-offset-[-2px]',
                      blocked ? 'opacity-40' : 'hover:bg-hover',
                    )}
                  >
                    {e}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {!q.trim() ? (
        <nav className="flex shrink-0 items-center justify-between border-t border-line px-3 py-1" aria-label={t('chat.emojiGroups')}>
          {recent.length ? (
            <GroupTab label={t('chat.emojiRecent')} active={(active ?? 'recent') === 'recent'} onClick={() => jumpTo(scroller.current, 'recent')}>
              <Clock3 className="size-5" aria-hidden />
            </GroupTab>
          ) : null}
          {EMOJI_GROUPS.map((g, i) => {
            const Icon = GROUP_ICONS[g.id] ?? Smile;
            const on = active ? active === g.id : !recent.length && i === 0;
            return (
              <GroupTab key={g.id} label={t(g.label)} active={on} onClick={() => jumpTo(scroller.current, g.id)}>
                <Icon className="size-5" aria-hidden />
              </GroupTab>
            );
          })}
        </nav>
      ) : null}
    </>
  );
}

function jumpTo(scroller: HTMLDivElement | null, id: string): void {
  const el = scroller?.querySelector<HTMLElement>(`#emoji-${id}`);
  if (scroller && el) scroller.scrollTo({ top: el.offsetTop - scroller.offsetTop });
}

function GroupTab({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-current={active || undefined}
        onClick={onClick}
        className={cx(
          'relative grid size-8 place-items-center rounded-[var(--radius-icon)] hover:bg-hover hover:text-fg',
          active ? 'text-accent' : 'text-muted',
        )}
      >
        {children}
        {active ? <span className="absolute inset-x-1.5 -bottom-1 h-0.5 rounded-full bg-accent" aria-hidden /> : null}
      </button>
    </Tip>
  );
}

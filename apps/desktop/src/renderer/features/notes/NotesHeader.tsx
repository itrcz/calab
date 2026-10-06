import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type { Room } from '@calaba/protocol';
import { Ellipsis, Lock, NotebookText, Pencil, Search, Smile, Trash2 } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { IconButton, MOD, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useMobile } from '../../lib/mobile';
import { deleteShelf, updateShelf } from '../../services/notes';
import { MAX_SHELF_NAME, useNotes } from '../../stores/notes';
import { useChatView } from '../chat/chatView';
import { EmojiPicker } from '../chat/EmojiPicker';
import { PinsButton } from '../chat/RoomHeader';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { NavButton } from '../../components/PhoneHeader';

/**
 * A notes shelf's header (ADR-0039): its emoji (click — another one), the name (click «⋯ →
 * Переименовать» or double-click — renamed in place: Enter saves, Esc cancels), «• Только для вас»;
 * on the right search in the shelf, pinned, «⋯» (rename, emoji, delete). No members, voice or
 * notifications: a shelf is mine alone.
 */
export function NotesHeader({ room }: { room: Room }): ReactNode {
  const name = useNotes((s) => s.byRoom[room.id]?.name ?? room.name);
  const emoji = useNotes((s) => s.byRoom[room.id]?.emoji ?? '');
  const searchOpen = useChatView((s) => s.searchRoom === room.id);
  const setSearch = useChatView((s) => s.setSearch);
  const [renaming, setRenaming] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const mobile = useMobile();
  const touch = mobile ? 'size-11 rounded-full' : undefined;
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('notes.deleteTitle', { name }), t('notes.deleteConfirm'), t('common.delete'))) await deleteShelf(room.id);
  };
  return (
    <header
      className={cx('mat-toolbar drag sticky top-0 z-[var(--z-sticky)] flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-2', mobile && 'gap-1 pl-0.5 pr-1')}
      data-testid="notes-header-bar"
    >
      {mobile ? <NavButton /> : null}
      <EmojiPicker key={emojiOpen} label={t('notes.changeEmoji')} closeOnPick side="bottom" defaultOpen={emojiOpen > 0} onPick={(e) => void updateShelf(room.id, { emoji: e })}>
        <button type="button" aria-label={t('notes.changeEmoji')} className="no-drag grid size-8 shrink-0 place-items-center rounded-[var(--radius-control)] text-[18px] leading-none hover:bg-hover">
          {emoji || <NotebookText className="size-[18px] text-accent-text" strokeWidth={1.75} aria-hidden />}
        </button>
      </EmojiPicker>
      {renaming ? (
        <RenameField
          initial={name}
          onDone={(n) => {
            setRenaming(false);
            if (n && n !== name) void updateShelf(room.id, { name: n });
          }}
        />
      ) : (
        <h1 className={cx('min-w-0 max-w-[50%] shrink-0 truncate text-list font-semibold', mobile && 'max-w-none shrink')} title={name} onDoubleClick={() => setRenaming(true)}>
          {name}
        </h1>
      )}
      <span className={cx('flex min-w-0 flex-1 items-center gap-1.5 text-body text-muted', mobile && 'hidden')}>
        <span className="text-faint" aria-hidden>
          •
        </span>
        <Lock className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t('notes.private')}</span>
      </span>
      <div className={cx('no-drag flex shrink-0 items-center gap-0.5', mobile && 'ml-auto')}>
        <IconButton label={t('notes.searchIn')} shortcut={`${MOD}F`} active={searchOpen} onClick={() => setSearch(searchOpen ? null : room.id)} className={touch}>
          <Search className="size-[18px]" />
        </IconButton>
        {mobile ? null : <PinsButton workspaceId="" roomId={room.id} canManage />}
        <Dropdown.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <Tip label={t('notes.more')}>
            <Dropdown.Trigger asChild>
              <IconButton tip={false} label={t('notes.more')} active={menuOpen} className={touch} data-testid="notes-actions">
                <Ellipsis className="size-[18px]" />
              </IconButton>
            </Dropdown.Trigger>
          </Tip>
          <Dropdown.Portal>
            <Dropdown.Content className={menuBox} align="end" sideOffset={8} collisionPadding={16} aria-label={t('notes.more')}>
              <Dropdown.Item className={menuItem} onSelect={() => setRenaming(true)}>
                <Pencil className="size-4" aria-hidden /> {t('notes.rename')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={() => setEmojiOpen((n) => n + 1)}>
                <Smile className="size-4" aria-hidden /> {t('notes.changeEmoji')}
              </Dropdown.Item>
              {emoji ? (
                <Dropdown.Item className={menuItem} onSelect={() => void updateShelf(room.id, { emoji: '' })}>
                  <NotebookText className="size-4" aria-hidden /> {t('notes.removeEmoji')}
                </Dropdown.Item>
              ) : null}
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
                <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
    </header>
  );
}

/** The name in place: Enter / blur saves (an empty name keeps the old one), Esc cancels. */
function RenameField({ initial, onDone }: { initial: string; onDone: (name: string) => void }): ReactNode {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string): void => {
    if (done.current) return;
    done.current = true;
    onDone(v.trim());
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish('');
    }
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      value={value}
      maxLength={MAX_SHELF_NAME}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => finish(value)}
      aria-label={t('notes.name')}
      className="no-drag h-8 w-[min(280px,50%)] min-w-0 rounded-[var(--radius-control)] border border-accent bg-[var(--color-bg)] px-2 text-list font-semibold text-fg"
    />
  );
}

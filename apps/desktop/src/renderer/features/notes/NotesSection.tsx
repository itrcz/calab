import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useSensor, useSensors, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { Check, Ellipsis, NotebookText, Plus, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { confirmAction } from '../../components/Confirm';
import { InlineAdd } from '../../components/CreateButton';
import { Tip, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { fmt, useTimeFormat } from '../../lib/format';
import type { DropAction, DropTarget } from '../../lib/messageDrag';
import { useMobile } from '../../lib/mobile';
import { createShelf, deleteShelf, moveShelf, openShelf, shelfName, updateShelf } from '../../services/notes';
import { HOME } from '../../stores/dms';
import { DEFAULT_SHELF_EMOJI, MAX_SHELF_NAME, shelfDropAt, shelfTitle, sortedShelves, useNotes, type ShelfEntry } from '../../stores/notes';
import { useUi } from '../../stores/ui';
import { EmojiPicker } from '../chat/EmojiPicker';
import { usePreviewParts } from '../chat/mentionText';
import { PreviewRuns } from '../chat/PreviewRuns';
import { useChatDrop } from '../chat/useChatDrop';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { applyChatDrop } from './dropActions';

/**
 * «Заметки» (ADR-0039, docs/05): the section above «Личные» in the DM column — my shelves in my
 * order (emoji, name, the last note and its time), «+» for a new one (the name inline, Enter saves,
 * Esc cancels), «⋯» / right click: rename, emoji, delete. Drag and drop (docs/08 «Заметки»): a
 * message dropped on a shelf is saved there, on the header — into the first shelf; OS files dropped
 * on a shelf are sent to it; shelves are reordered by dragging (desktop).
 */
export function NotesSection(): ReactNode {
  const byRoom = useNotes((s) => s.byRoom);
  const list = useMemo(() => sortedShelves(byRoom), [byRoom]);
  const [creating, setCreating] = useState(false);
  const first = list[0]?.roomId ?? '';
  const headerTarget = useMemo<DropTarget | null>(() => (first ? { kind: 'shelf', roomId: first, files: true, canSend: true } : null), [first]);
  const onHeaderDrop = useCallback((a: DropAction, files: File[]) => applyChatDrop(a, files, shelfName(a.toRoomId), true), []);
  const [headerOver, headerDrop] = useChatDrop(headerTarget, onHeaderDrop);
  const firstEntry = list[0];

  return (
    <section className="mb-2" aria-label={t('notes.section')} data-testid="notes-section">
      <div
        className={cx('group/cat flex h-7 items-center rounded-[var(--radius-row)] pr-1 pt-1 mobile:h-11 mobile:pr-0 mobile:pt-0', headerOver && 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)]')}
        data-testid="notes-header"
        {...headerDrop}
      >
        <h2 className="min-w-0 flex-1 truncate pl-2 text-micro font-semibold uppercase tracking-[0.04em] text-muted">
          {headerOver && firstEntry ? <span className="normal-case tracking-normal text-accent-text">{t('notes.saveTo', { name: shelfTitle(firstEntry) })}</span> : t('notes.section')}
        </h2>
        <InlineAdd label={t('notes.new')} onClick={() => setCreating(true)} data-testid="notes-new" />
      </div>
      {list.length ? <ShelfList list={list} /> : null}
      {creating ? (
        <ShelfForm
          initialName=""
          initialEmoji={DEFAULT_SHELF_EMOJI}
          onSubmit={(name, emoji) => void createShelf(name, emoji)}
          onDone={() => setCreating(false)}
        />
      ) : list.length === 0 ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-0.5 flex w-full items-center gap-2.5 rounded-[var(--radius-row)] border border-dashed border-line px-2 py-2 text-left text-caption text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg"
          data-testid="notes-empty"
        >
          <Plus className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{t('notes.empty')}</span>
        </button>
      ) : null}
    </section>
  );
}

/** The shelves with drag reordering (desktop; a phone scrolls instead). */
function ShelfList({ list }: { list: ShelfEntry[] }): ReactNode {
  const mobile = useMobile();
  const listRef = useRef<HTMLUListElement>(null);
  // 6 px before a drag starts: a click on a shelf stays a click (as the room list).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragged, setDragged] = useState<ShelfEntry | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const target = useRef<number | null>(null);
  const startY = useRef(0);

  const measure = (id: string, y: number): void => {
    const el = listRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const slots = [...el.querySelectorAll<HTMLElement>('[data-shelf-slot]')].map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.dataset.shelfSlot ?? '', top: r.top - box.top, bottom: r.bottom - box.top };
    });
    const drop = shelfDropAt(slots, y - box.top, id);
    target.current = drop?.index ?? null;
    setLine(drop ? drop.lineY : null);
  };
  const reset = (): void => {
    setDragged(null);
    setLine(null);
    target.current = null;
  };
  const onStart = (e: DragStartEvent): void => {
    setDragged(list.find((s) => s.roomId === e.active.id) ?? null);
    startY.current = (e.activatorEvent as PointerEvent).clientY;
  };
  const onMove = (e: DragMoveEvent): void => measure(String(e.active.id), startY.current + e.delta.y);
  const onEnd = (): void => {
    const d = dragged;
    const to = target.current;
    reset();
    if (d && to !== null) void moveShelf(d.roomId, to);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onStart} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={reset}>
      <ul ref={listRef} className="relative mt-0.5 flex flex-col gap-px" data-testid="notes-list">
        {list.map((e) => (
          <ShelfRow key={e.roomId} entry={e} canDrag={!mobile} />
        ))}
        {line !== null ? (
          <div aria-hidden className="pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent" style={{ top: Math.max(0, line - 1) }} data-testid="notes-drop-line" />
        ) : null}
      </ul>
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {dragged ? (
            <div className="mat-popover flex h-8 w-max max-w-[220px] items-center gap-2 rounded-[var(--radius-row)] px-2 text-list text-fg">
              <ShelfIcon emoji={dragged.emoji} size={20} />
              <span className="truncate">{dragged.name}</span>
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

function ShelfIcon({ emoji, size }: { emoji: string; size: number }): ReactNode {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[var(--radius-control)] bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] leading-none text-accent-text"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.56) }}
    >
      {emoji || <NotebookText style={{ width: size * 0.55, height: size * 0.55 }} strokeWidth={1.75} />}
    </span>
  );
}

const ShelfRow = memo(function ShelfRow({ entry, canDrag }: { entry: ShelfEntry; canDrag: boolean }): ReactNode {
  // Memo row: re-render on a language / clock format switch too (ADR-0022, docs/09 #73).
  useLocale();
  useTimeFormat();
  const { roomId, name, emoji } = entry;
  const active = useUi((s) => s.activeWorkspaceId === HOME && s.lastRoom[HOME] === roomId);
  const preview = useNotes((s) => s.preview[roomId]);
  const parts = usePreviewParts(null, preview?.content ?? '');
  const [editing, setEditing] = useState<'name' | 'emoji' | null>(null);
  const target = useMemo<DropTarget>(() => ({ kind: 'shelf', roomId, files: true, canSend: true }), [roomId]);
  const onDrop = useCallback((a: DropAction, files: File[]) => applyChatDrop(a, files, shelfName(roomId), true), [roomId]);
  const [over, drop] = useChatDrop(target, onDrop);
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: roomId, disabled: !canDrag || editing !== null });

  if (editing) {
    return (
      <li data-shelf-slot={roomId}>
        <ShelfForm
          initialName={name}
          initialEmoji={emoji}
          emojiFirst={editing === 'emoji'}
          onSubmit={(n, e) => void updateShelf(roomId, { ...(n !== name ? { name: n } : {}), ...(e !== emoji ? { emoji: e } : {}) })}
          onDone={() => setEditing(null)}
        />
      </li>
    );
  }

  const line = over ? (
    <span className="text-accent-text">{t('notes.saveTo', { name: shelfTitle(entry) })}</span>
  ) : preview === undefined ? (
    ''
  ) : preview === null ? (
    t('notes.emptyHint')
  ) : parts.length ? (
    <PreviewRuns parts={parts} />
  ) : preview.attachments ? (
    t('chat.attachment')
  ) : (
    ''
  );
  const time = preview?.at ? fmt.listTime(new Date(preview.at)) : '';
  return (
    <ShelfMenu roomId={roomId} name={name} onEdit={setEditing} asContext>
      <li
        ref={setNodeRef}
        data-shelf-slot={roomId}
        data-testid="notes-shelf"
        data-over={over || undefined}
        className={cx(
          'group/row relative flex h-[46px] items-center rounded-[var(--radius-row)] transition-colors duration-[var(--motion-fast)]',
          over ? 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] shadow-[inset_0_0_0_1px_var(--color-accent)]' : active ? 'bg-active' : 'hover:bg-hover',
          isDragging && 'opacity-40',
        )}
        {...drop}
      >
        <button
          type="button"
          onClick={() => openShelf(roomId)}
          aria-current={active ? 'page' : undefined}
          aria-label={shelfTitle(entry)}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-row)] pl-2 pr-1 text-left"
          {...(canDrag ? listeners : {})}
        >
          <ShelfIcon emoji={emoji} size={32} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cx('min-w-0 flex-1 truncate text-list leading-5', active || over ? 'text-fg' : 'text-muted group-hover/row:text-fg')} title={name}>
                {name}
              </span>
              <span className="shrink-0 text-micro text-faint">{time}</span>
            </span>
            <span className="min-w-0 truncate text-caption leading-4 text-muted">{line}</span>
          </span>
        </button>
        <ShelfMenu roomId={roomId} name={name} onEdit={setEditing}>
          <button
            type="button"
            aria-label={t('notes.more')}
            data-testid="notes-shelf-more"
            className="mr-1 grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 transition-opacity duration-[var(--motion-fast)] hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 mobile:opacity-100"
          >
            <Ellipsis className="size-4" aria-hidden />
          </button>
        </ShelfMenu>
      </li>
    </ShelfMenu>
  );
});

/** «⋯» (a dropdown) or the row's right-click menu: rename, emoji, delete (confirmed). */
function ShelfMenu({
  roomId,
  name,
  onEdit,
  asContext = false,
  children,
}: {
  roomId: string;
  name: string;
  onEdit: (what: 'name' | 'emoji') => void;
  asContext?: boolean;
  children: ReactNode;
}): ReactNode {
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('notes.deleteTitle', { name }), t('notes.deleteConfirm'), t('common.delete'))) await deleteShelf(roomId);
  };
  const items = (Item: typeof Dropdown.Item | typeof ContextMenu.Item, Sep: typeof Dropdown.Separator | typeof ContextMenu.Separator): ReactNode => (
    <>
      <Item className={menuItem} onSelect={() => onEdit('name')} data-testid="notes-rename">
        {t('notes.rename')}
      </Item>
      <Item className={menuItem} onSelect={() => onEdit('emoji')}>
        {t('notes.changeEmoji')}
      </Item>
      <Sep className={menuSeparator} />
      <Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()} data-testid="notes-delete">
        {t('common.delete')}
      </Item>
    </>
  );
  if (asContext) {
    return (
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={menuBox}>{items(ContextMenu.Item, ContextMenu.Separator)}</ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  }
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={menuBox} align="start" sideOffset={4} collisionPadding={16}>
          {items(Dropdown.Item, Dropdown.Separator)}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/**
 * The inline shelf form (a new shelf, rename, emoji): the emoji button and the name, Enter saves,
 * Esc cancels; focus leaving the form saves a non-empty name (not while its emoji picker is open).
 */
function ShelfForm({
  initialName,
  initialEmoji,
  emojiFirst = false,
  onSubmit,
  onDone,
}: {
  initialName: string;
  initialEmoji: string;
  emojiFirst?: boolean;
  onSubmit: (name: string, emoji: string) => void;
  onDone: () => void;
}): ReactNode {
  const [name, setName] = useState(initialName);
  const [emoji, setEmoji] = useState(initialEmoji);
  const picker = useRef(emojiFirst);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const finish = (save: boolean): void => {
    if (done.current) return;
    done.current = true;
    const n = name.trim();
    if (save && n) onSubmit(n, emoji);
    onDone();
  };
  useEffect(() => {
    if (!emojiFirst) input.current?.select();
  }, [emojiFirst]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };
  return (
    <div
      ref={box}
      className="mt-0.5 flex h-[46px] items-center gap-1.5 rounded-[var(--radius-row)] bg-hover pl-1.5 pr-1"
      data-testid="notes-form"
      onBlur={(e) => {
        if (picker.current || (e.relatedTarget instanceof Node && box.current?.contains(e.relatedTarget))) return;
        finish(true);
      }}
    >
      <EmojiPicker
        label={t('notes.emoji')}
        closeOnPick
        defaultOpen={emojiFirst}
        side="bottom"
        onOpenChange={(open) => {
          picker.current = open;
          if (!open) input.current?.focus();
        }}
        onPick={(e) => setEmoji(e)}
      >
        <button type="button" aria-label={t('notes.emoji')} className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-[var(--color-fill-hover)]">
          <ShelfIcon emoji={emoji} size={28} />
        </button>
      </EmojiPicker>
      <input
        ref={input}
        autoFocus={!emojiFirst}
        value={name}
        maxLength={MAX_SHELF_NAME}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKey}
        placeholder={t('notes.name')}
        aria-label={t('notes.name')}
        data-testid="notes-name"
        className="h-8 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-[var(--color-bg)] px-2 text-body text-fg placeholder:text-faint"
      />
      <Tip label={t('notes.save')}>
        <button
          type="button"
          aria-label={t('notes.save')}
          disabled={!name.trim()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => finish(true)}
          className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-[var(--color-fill-hover)] hover:text-fg disabled:opacity-40"
        >
          <Check className="size-4" aria-hidden />
        </button>
      </Tip>
      <Tip label={t('common.cancel')}>
        <button
          type="button"
          aria-label={t('common.cancel')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => finish(false)}
          className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-[var(--color-fill-hover)] hover:text-fg"
        >
          <X className="size-4" aria-hidden />
        </button>
      </Tip>
    </div>
  );
}


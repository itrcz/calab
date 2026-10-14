import * as ContextMenu from '@radix-ui/react-context-menu';
import type { Room } from '@calaba/protocol';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PICKER_DEBOUNCE_MS, filterItems, type PickerItem } from '../../components/picker/pickerModel';
import { cx } from '../../components/ui';
import { RoomIcon } from '../../components/RoomIcon';
import { t } from '../../i18n';

/** The room variant of the picker (docs/08 «Выбор участника»): «Переместить в ›» and the like. */
export interface RoomPickItem extends PickerItem {
  room: Room;
}

export const roomPickItems = (rooms: readonly Room[]): RoomPickItem[] => rooms.map((room) => ({ id: room.id, room, search: [room.name, room.topic] }));

/** Above this many rooms the submenu gets its search field. */
export const ROOM_SEARCH_MIN = 6;

/** A room row: the type icon (speaker / #), the name, a lock for a private room. */
export function RoomPickRow({ room }: { room: Room }): ReactNode {
  return (
    <>
      <RoomIcon roomId={room.id} room={room} size={16} ring="var(--color-popover-solid)" />
      <span className="min-w-0 flex-1 truncate" title={room.name}>
        {room.name}
      </span>
    </>
  );
}

/**
 * Rooms inside a Radix context submenu (the member menu's «Переместить в ›»): real menu items
 * (Radix keeps their keyboard, typeahead and closing), with a search field on top once the list
 * is long. In the field: ↓ goes to the first match, Enter picks it, typing never reaches the
 * menu's typeahead.
 */
export function RoomSubmenuPicker({ rooms, onSelect, itemClass }: { rooms: readonly Room[]; onSelect: (room: Room) => void; itemClass: string }): ReactNode {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), text.trim() ? PICKER_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [text]);
  const all = useMemo(() => roomPickItems(rooms), [rooms]);
  const items = useMemo(() => filterItems(all, query), [all, query]);
  const search = rooms.length > ROOM_SEARCH_MIN;
  return (
    <>
      {search ? (
        <div className="relative px-0.5 pb-1 pt-0.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                first.current?.focus();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                // The list may lag the debounce: pick the first match of what is typed now.
                const now = filterItems(all, text.trim())[0];
                if (now) {
                  if (now.id === items[0]?.id) first.current?.click();
                  else onSelect(now.room);
                }
              }
              if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation();
            }}
            maxLength={64}
            aria-label={t('picker.searchRooms')}
            placeholder={t('picker.searchRooms')}
            autoComplete="off"
            className="selectable h-7 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-elev pl-7 pr-2 text-body text-fg placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className="px-2 py-3 text-center text-body text-muted" data-testid="picker-empty">
          {t('picker.noRooms')}
        </div>
      ) : (
        items.map((it, i) => (
          <ContextMenu.Item key={it.id} ref={i === 0 ? first : undefined} className={cx(itemClass)} onSelect={() => onSelect(it.room)} data-testid="room-pick">
            <RoomPickRow room={it.room} />
          </ContextMenu.Item>
        ))
      )}
    </>
  );
}

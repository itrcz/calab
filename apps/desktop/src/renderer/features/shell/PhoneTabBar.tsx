import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { WorkspaceRole } from '@calaba/protocol';
import { ChevronDown, Ellipsis, Pin } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';
import { BoardsActiveIcon, BoardsIdleIcon, CalendarActiveIcon, CalendarIdleIcon, DiskActiveIcon, DiskIdleIcon, PersonalActiveIcon, PersonalIdleIcon, TeamActiveIcon, TeamIdleIcon, WikiActiveIcon, WikiIdleIcon } from '../../assets/nav/icons';
import { CountBadge, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { PHONE_TABS, barTabs, pinTab, type PhoneTab } from '../../lib/phoneNav';
import { UNREAD_DOT, dmBadge, type Badge } from '../../lib/sections';
import { openTab } from '../../services/phoneNav';
import { unreadCount, useBoards } from '../../stores/boards';
import { HOME, isDm } from '../../stores/dms';
import { usePrefs } from '../../stores/prefs';
import { showsUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { ProfileTabIcon } from './PhoneProfile';

/**
 * The phone's bottom tab bar (ADR-0073 §1, ADR-0095): three pinned tabs and «Ещё». «Ещё» opens a
 * centred card (a Radix Dropdown: lib/phoneMenus.ts does the card look) with every section the
 * account may open, a 52 px row each: icon · name · unread · a pin button. A tap on a row opens the
 * section, a tap on the pin changes the pinned set (exactly three; the oldest is replaced) and
 * leaves the card open. When the open section is not pinned, the fourth button shows its icon and
 * name on a plate with a «⌄» — a switch that reopens the card.
 *
 * Re-renders (CLAUDE.md): the bar subscribes to primitives (guest flag, can-open-full), the pinned
 * list and the open tab; buttons are memo; badges are leaves with id-free primitive selectors that
 * short-circuit to 0 for tabs they do not show; the card is mounted only while open (Radix portal).
 */

/** The name of a tab, as the bar and the card show it. */
export function tabLabel(tab: PhoneTab): string {
  switch (tab) {
    case 'chats':
      return t('mobile.tabChats');
    case 'dms':
      return t('mobile.tabDms');
    case 'boards':
      return t('shell.modeBoards');
    case 'calendar':
      return t('cal.open');
    case 'disk':
      return t('mobile.tabDisk');
    case 'wiki':
      return t('mobile.tabWiki');
    case 'profile':
      return t('mobile.profile');
  }
}

/** The tab's icon: the owner's drawings (filled when open), «Профиль» my avatar. `cls` sizes the drawings. */
const TabIcon = memo(function TabIcon({ tab, active, cls }: { tab: PhoneTab; active: boolean; cls: string }): ReactNode {
  switch (tab) {
    case 'chats':
      return active ? <TeamActiveIcon className={cls} /> : <TeamIdleIcon className={cls} />;
    case 'dms':
      return active ? <PersonalActiveIcon className={cls} /> : <PersonalIdleIcon className={cls} />;
    case 'boards':
      return active ? <BoardsActiveIcon className={cls} /> : <BoardsIdleIcon className={cls} />;
    case 'calendar':
      return active ? <CalendarActiveIcon className={cls} /> : <CalendarIdleIcon className={cls} />;
    case 'disk':
      return active ? <DiskActiveIcon className={cls} /> : <DiskIdleIcon className={cls} />;
    case 'wiki':
      return active ? <WikiActiveIcon className={cls} /> : <WikiIdleIcon className={cls} />;
    case 'profile':
      return <ProfileTabIcon active={active} />;
  }
});

const ICON = 'size-7';

export function TabBar({ tab }: { tab: PhoneTab }): ReactNode {
  const guest = useSession((s) => !!s.me?.user?.isGuest);
  // Calendar, boards and the disk belong to a workspace the account is a full member of (a guest has rooms only).
  const full = useWorkspaces((s) => s.order.some((id) => s.byId[id] && s.byId[id].role !== WorkspaceRole.GUEST));
  const pinned = usePrefs((s) => s.phonePinnedTabs);
  const available = useMemo(
    () =>
      PHONE_TABS.filter((x) => {
        if (x === 'dms') return !guest;
        if (x === 'boards' || x === 'calendar' || x === 'disk' || x === 'wiki') return full && !guest;
        return true;
      }),
    [guest, full],
  );
  const { bar, more } = useMemo(() => barTabs(pinned, available), [pinned, available]);
  const hidden = useMemo(() => available.filter((x) => !bar.includes(x)), [available, bar]);
  const inBar = bar.includes(tab);
  return (
    <nav
      aria-label={t('mobile.tabs')}
      data-testid="phone-tabbar"
      className="mat-toolbar flex shrink-0 border-t border-line pb-[var(--safe-bottom,0px)] [.kb-open_&]:hidden"
    >
      {bar.map((x) => (
        <TabButton key={x} tab={x} active={x === tab} />
      ))}
      {more || !inBar ? <MoreButton tab={tab} inBar={inBar} hidden={hidden} available={available} /> : null}
    </nav>
  );
}

const BUTTON = 'relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-micro font-medium';

const TabButton = memo(function TabButton({ tab, active }: { tab: PhoneTab; active: boolean }): ReactNode {
  return (
    <button
      type="button"
      onClick={() => {
        if (!active) haptics.tap();
        openTab(tab);
      }}
      aria-current={active ? 'page' : undefined}
      data-testid={`phone-tab-${tab}`}
      className={cx(BUTTON, active ? 'text-fg' : 'text-muted')}
    >
      <span className="relative flex">
        <TabIcon tab={tab} active={active} cls={ICON} />
        <BadgeOf tabs={[tab]} />
      </span>
      <span className="max-w-full truncate px-1">{tabLabel(tab)}</span>
    </button>
  );
});

/** «Ещё» (`⋯`), or — when the open section is not pinned — that section on a plate with «⌄». */
const MoreButton = memo(function MoreButton({ tab, inBar, hidden, available }: { tab: PhoneTab; inBar: boolean; hidden: readonly PhoneTab[]; available: readonly PhoneTab[] }): ReactNode {
  const others = useMemo(() => (inBar ? hidden : hidden.filter((x) => x !== tab)), [inBar, hidden, tab]);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-current={inBar ? undefined : 'page'}
          aria-label={inBar ? t('mobile.more') : `${tabLabel(tab)}, ${t('mobile.more')}`}
          data-testid="phone-tab-more"
          className={cx(BUTTON, inBar ? 'flex-[1.7] text-muted' : 'flex-[1.7] px-2 text-fg')}
          onClick={() => haptics.tap()}
        >
          {inBar ? (
            <>
              <span className="relative flex">
                <span className={cx(ICON, 'flex items-center justify-center')}>
                  <Ellipsis className="size-6" strokeWidth={1.75} aria-hidden />
                </span>
                <BadgeOf tabs={others} />
              </span>
              <span className="max-w-full truncate px-1">{t('mobile.more')}</span>
            </>
          ) : (
            <span data-testid="phone-tab-more-plate" className="relative flex h-9 w-full min-w-0 items-center justify-center gap-1 rounded-[10px] bg-hover px-2">
              <span className="flex size-7 shrink-0 items-center justify-center"><TabIcon tab={tab} active cls="size-[22px]" /></span>
              <span className="min-w-0 truncate">{tabLabel(tab)}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted" strokeWidth={2.25} aria-hidden />
              <BadgeOf tabs={others} plate />
            </span>
          )}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          data-testid="phone-more-card"
          className="mat-popover anim-in z-[var(--z-popover)] w-72 rounded-[var(--radius-card)] p-1 text-fg"
          sideOffset={8}
          collisionPadding={16}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {available.map((x) => (
            <MoreRow key={x} tab={x} />
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
});

/** Pins `tab`; a fourth pin replaces the oldest (toast names it). A pinned tab stays: the set is always three. */
function pin(tab: PhoneTab): void {
  const cur = usePrefs.getState().phonePinnedTabs;
  const { pinned, unpinned } = pinTab(cur, tab);
  if (!unpinned && pinned.length === cur.length && pinned.every((x, i) => x === cur[i])) return;
  usePrefs.getState().setPrefs({ phonePinnedTabs: pinned });
  haptics.select();
  if (unpinned) toast.info(t('mobile.pinnedInstead', { name: tabLabel(unpinned) }));
}

/** A row of the «Ещё» card: the section (tap = open) and its pin (a separate 44 px button, the card stays open). */
const MoreRow = memo(function MoreRow({ tab }: { tab: PhoneTab }): ReactNode {
  const pinned = usePrefs((s) => s.phonePinnedTabs.includes(tab));
  const active = useUi((s) => s.phone.tab === tab);
  const label = tabLabel(tab);
  return (
    <div className="flex h-[52px] items-center" role="none">
      <Dropdown.Item
        className="flex h-[52px] min-w-0 flex-1 cursor-default items-center gap-3 rounded-[var(--radius-control)] pl-2.5 pr-1 text-list outline-none data-[highlighted]:bg-hover"
        onSelect={() => {
          if (!active) haptics.tap();
          openTab(tab);
        }}
        aria-current={active ? 'page' : undefined}
        data-testid={`more-row-${tab}`}
      >
        <span className="flex size-7 shrink-0 items-center justify-center"><TabIcon tab={tab} active={active} cls="size-6" /></span>
        <span className={cx('min-w-0 flex-1 truncate', active && 'font-semibold')}>{label}</span>
        <BadgeOf tabs={[tab]} inline />
      </Dropdown.Item>
      {/* A menuitemcheckbox, not a bare button: a menu may hold menu items only (axe aria-required-children); onSelect keeps the card open. */}
      <Dropdown.CheckboxItem
        checked={pinned}
        aria-label={t('mobile.pin', { name: label })}
        data-testid={`more-pin-${tab}`}
        onSelect={(e) => {
          e.preventDefault();
          pin(tab);
        }}
        className={cx('grid size-11 shrink-0 cursor-default place-items-center rounded-full outline-none data-[highlighted]:bg-hover', pinned ? 'text-fg' : 'text-muted')}
      >
        <Pin className={cx('size-5', pinned && 'fill-current')} strokeWidth={1.75} aria-hidden />
      </Dropdown.CheckboxItem>
    </div>
  );
});

// ---------------------------------------------------------------- badges

/**
 * The unread of the given tabs as one primitive (lib/sections.ts Badge): > 0 the summed count, -1 a
 * dot, 0 nothing. «Команда»: mentions across the workspaces' rooms (a dot for plain unread);
 * «Личные»: every DM message; «Доски»: unread tasks of the open workspace (the one the old switch
 * showed). Each selector returns 0 for a tab not asked for, so a badge re-renders only for its own data.
 */
function useBadge(tabs: readonly PhoneTab[]): Badge {
  const wantChats = tabs.includes('chats');
  const wantDms = tabs.includes('dms');
  const wantBoards = tabs.includes('boards');
  const chats = useRooms((s) => {
    if (!wantChats) return 0;
    let n = 0;
    let unread = false;
    for (const id in s.mentions) {
      const r = s.byId[id];
      if (r && !isDm(r) && r.workspaceId !== '') n += s.mentions[id] ?? 0;
    }
    if (n === 0) unread = Object.values(s.byId).some((r) => r.workspaceId !== '' && !isDm(r) && showsUnread(r.id, s));
    return n > 0 ? n : unread ? UNREAD_DOT : 0;
  });
  const dms = useRooms((s) => (wantDms ? dmBadge(s) : 0));
  const open = useUi((s) => (s.activeWorkspaceId === HOME ? null : s.activeWorkspaceId));
  const first = useWorkspaces((s) => s.order[0] ?? null);
  const wsId = open ?? first;
  const boards = useBoards((s) => (wantBoards && wsId ? unreadCount(s, wsId) : 0));
  const count = Math.max(chats, 0) + dms + boards;
  return count > 0 ? count : chats === UNREAD_DOT ? UNREAD_DOT : 0;
}

/** A tab's badge: a count on the icon corner (or inline in a card row), or a dot. A leaf with its own subscription. */
function BadgeOf({ tabs, inline = false, plate = false }: { tabs: readonly PhoneTab[]; inline?: boolean; plate?: boolean }): ReactNode {
  const b = useBadge(tabs);
  if (b === 0) return null;
  const count = Math.max(b, 0);
  const only = tabs.length === 1 ? tabs[0] : undefined;
  const label =
    count === 0
      ? t('ws.unread')
      : only === 'chats'
        ? plural('shell.unreadMentions', count)
        : only === 'dms'
          ? t('dm.homeUnread', { n: count })
          : only === 'boards'
            ? plural('boards.unreadCount', count)
            : `${t('ws.unread')}: ${count}`;
  if (inline) {
    return count > 0 ? (
      <CountBadge count={count} phone role="img" aria-label={label} />
    ) : (
      <span role="img" aria-label={label} className="size-2.5 shrink-0 rounded-full bg-fg" />
    );
  }
  return count > 0 ? (
    <CountBadge count={count} phone ring="var(--color-toolbar,var(--color-bg))" role="img" aria-label={label} className={plate ? 'absolute -top-2 right-0' : 'absolute -top-2 left-full -ml-2.5'} />
  ) : (
    <span role="img" aria-label={label} className="absolute -right-1 -top-0.5 size-2.5 rounded-full border-2 border-[var(--color-toolbar,var(--color-bg))] bg-fg" />
  );
}

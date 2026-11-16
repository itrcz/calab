import * as ContextMenu from '../../components/radix/context-menu';
import { SipCallStatus, type SipJournalEntry, SipActiveStep } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Copy, Info, MessageCircle, Phone, PhoneMissed, Play, UserRound, UserRoundPlus } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Avatar, avatarColor } from '../../components/Avatar';
import { IconButton, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useTimeFormat } from '../../lib/format';
import { workspaceInitials } from '../../lib/initials';
import { usePageVisible } from '../../lib/pageVisible';
import { useRowSwipe } from '../../lib/rowSwipe';
import { activeCallsKey } from '../../lib/sipPbx';
import { useSipJournal } from '../../stores/sipJournal';
import { useTelephonyUi } from '../../stores/telephonyUi';
import { useSwipeOpenMark } from '../../stores/telContacts';
import { useWorkspaces } from '../../stores/workspaces';
import { useShallow } from 'zustand/react/shallow';
import { menuBox, menuItem } from '../shell/menu';
import { formatDuration, useNow } from '../shell/voiceFormat';
import { useMayManageTelephony, usePlaceCalls } from './access';
import { callBack, copyNumber, internalPeer, openCallDetail, openOrAddContact, writeTo } from './actions';
import { toggleRecording } from './RecordingPlayer';
import { journalEntryKey } from '../../services/sipJournal';
import { liveText, outcomeText, partyName, rowTime } from './texts';
import { directionOf, isLiveCall, numberOf, outcomeOf, startOf } from './timeline';
import { asEnum } from '../../lib/enums';

/**
 * A row of «Недавние» (ADR-0137 §6 desktop 52 px, §7 phone 64 px): the party's circle with the
 * direction badge · the name (a missed call in red) with the company · the outcome line · the
 * time and ⓘ. Desktop: a click opens the detail on the right; «Позвонить» shows on hover / focus
 * (an employee — the internal call; a number — a personal call over the trunk with PLACE_CALLS).
 * Phone: a tap calls back (iPhone «Недавние») or, when it cannot, opens the detail; a left swipe
 * offers «Контакт» · «Копировать», a long press the row's menu.
 *
 * Re-renders: memo by id; the row subscribes to its own entry (a SIP_JOURNAL_ENTRY of another call
 * leaves it alone); a live call's timer and step are leaves.
 */
const NO_PARTY = { name: '', company: '', number: '' };

export const RecentsRow = memo(function RecentsRow({ id, ws, phone }: { id: string; ws: string; phone: boolean }): ReactNode {
  useLocale();
  useTimeFormat();
  const e = useSipJournal((s) => s.entries[id]);
  // Names follow renames of members: a string, a re-render only when it changes.
  const party = useWorkspaces(useShallow(() => (e ? partyName(ws, e) : NO_PARTY)));
  if (!e) return null;
  return phone ? <PhoneRow e={e} ws={ws} name={party.name} company={party.company} /> : <DesktopRow e={e} ws={ws} name={party.name} company={party.company} />;
});

function DesktopRow({ e, ws, name, company }: { e: SipJournalEntry; ws: string; name: string; company: string }): ReactNode {
  const id = e.call?.id ?? '';
  const selected = useTelephonyUi((s) => s.detail === id);
  const callable = useCallable(e, ws);
  return (
    <RowMenu e={e} ws={ws}>
      <div className={cx('group relative mx-2 flex h-[52px] items-center gap-3 rounded-[8px] px-2', selected ? 'bg-active' : 'hover:bg-row-hover')} data-testid="tel-row" data-call={id} data-selected={selected || undefined}>
        <button type="button" className="absolute inset-0 rounded-[8px]" aria-label={t('tel.openCall', { name })} aria-current={selected || undefined} onClick={() => openCallDetail(id)} />
        <PartyCircle e={e} ws={ws} name={name} size={32} ring="var(--color-bg)" />
        <RowText e={e} ws={ws} name={name} company={company} phone={false} />
        <span className="relative flex shrink-0 items-center gap-1">
          {callable ? (
            <IconButton label={t('tel.callName', { name })} onClick={() => callBack(e, ws)} className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 text-ok" data-testid="tel-row-call">
              <Phone className="size-4" aria-hidden />
            </IconButton>
          ) : null}
          <RowEnd e={e} />
          <IconButton label={t('tel.info')} onClick={() => openCallDetail(id)} data-testid="tel-row-info">
            <Info className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </IconButton>
        </span>
      </div>
    </RowMenu>
  );
}

/** The row can be called back (an employee I may call, or a number with PLACE_CALLS). */
function useCallable(e: SipJournalEntry, ws: string): boolean {
  const place = usePlaceCalls(ws);
  return !!internalPeer(e, ws) || (place && numberOf(e) !== '');
}

function PhoneRow({ e, ws, name, company }: { e: SipJournalEntry; ws: string; name: string; company: string }): ReactNode {
  const id = e.call?.id ?? '';
  // A left swipe: «Контакт» · «Копировать» (no delete: the journal is shared and serves as a record);
  // a hidden number: «Подробнее» only.
  const copy = numberOf(e) !== '';
  const swipe = useRowSwipe(true, copy ? 2 : 1);
  const shifted = swipe.offset !== 0;
  useSwipeOpenMark(shifted);
  const onTap = (): void => {
    if (shifted) {
      swipe.close();
      return;
    }
    // ADR-0137 §7: a tap calls back (iPhone «Недавние»); a number I cannot call yet opens the detail.
    if (!callBack(e, ws)) openCallDetail(id);
  };
  return (
    <div className="relative flex" {...swipe.handlers}>
      {shifted ? <SwipeActions e={e} width={Math.min(-swipe.offset, swipe.width)} close={swipe.close} copy={copy} /> : null}
      <RowMenu e={e} ws={ws}>
        <div
          className={cx('relative flex h-16 min-w-0 flex-1 select-none items-center gap-3 bg-[var(--color-bg)] pl-3 duration-[var(--motion-fast)] active:bg-hover', swipe.dragging ? 'transition-colors' : 'transition-[margin,background-color]')}
          style={shifted ? { marginRight: -swipe.offset } : undefined}
          data-testid="tel-row"
          data-call={id}
        >
          <button type="button" className="absolute inset-0" aria-label={t('tel.openCall', { name })} onClick={onTap} data-testid="tel-row-tap" />
          <PartyCircle e={e} ws={ws} name={name} size={40} ring="var(--color-bg)" />
          <span className="flex h-full min-w-0 flex-1 items-center gap-1 border-b border-line">
            <RowText e={e} ws={ws} name={name} company={company} phone />
            <span className="relative flex shrink-0 items-center">
              <RowEnd e={e} />
              <button
                type="button"
                className="tap-hit relative grid size-11 place-items-center text-accent-text"
                aria-label={t('tel.info')}
                onClick={() => openCallDetail(id)}
                data-testid="tel-row-info"
              >
                <Info className="size-6" strokeWidth={1.75} aria-hidden />
              </button>
            </span>
          </span>
        </div>
      </RowMenu>
    </div>
  );
}

/** Name (+ company) and the outcome; both one line (the time and ⓘ keep their place). */
function RowText({ e, ws, name, company, phone }: { e: SipJournalEntry; ws: string; name: string; company: string; phone: boolean }): ReactNode {
  const missed = e.missed;
  const live = isLiveCall(e.call?.status ?? SipCallStatus.UNSPECIFIED);
  return (
    <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={cx('min-w-0 shrink truncate tabular-nums', phone ? 'text-list font-semibold leading-5' : 'text-body font-medium', missed ? 'text-danger-text' : 'text-fg')} data-testid="tel-row-name">
          {name}
        </span>
        {company ? <span className={cx('min-w-[72px] flex-1 truncate text-muted', phone ? 'text-caption' : 'text-body')}>· {company}</span> : null}
      </span>
      <span className="truncate text-caption leading-4 text-muted" data-testid="tel-row-outcome">
        {live ? <LiveStep e={e} ws={ws} /> : outcomeText(ws, outcomeOf(e), e)}
      </span>
    </span>
  );
}

/** The right edge: a live call's timer, else the time of the call. */
function RowEnd({ e }: { e: SipJournalEntry }): ReactNode {
  const at = startOf(e);
  if (isLiveCall(e.call?.status ?? SipCallStatus.UNSPECIFIED)) return <LiveTimer since={at} />;
  return (
    <span className="pointer-events-none shrink-0 text-caption tabular-nums text-muted" data-testid="tel-row-time">
      {at ? rowTime(at) : ''}
    </span>
  );
}

/** How long a live call goes on: a leaf on the shared 1 s clock, no clock in a hidden window. */
function LiveTimer({ since }: { since: number }): ReactNode {
  const visible = usePageVisible();
  const now = useNow(visible ? 1000 : 0);
  return (
    <span className="pointer-events-none shrink-0 text-caption tabular-nums text-[var(--color-green-text)]" data-testid="tel-row-timer">
      {since ? formatDuration(Math.max(0, now - since)) : ''}
    </span>
  );
}

/** A live call's step: the exchange's own (ADR-0128) for MANAGE_INTEGRATIONS, else what the call says. */
function LiveStep({ e, ws }: { e: SipJournalEntry; ws: string }): ReactNode {
  const manage = useMayManageTelephony(ws);
  const id = e.call?.id ?? '';
  const q = useQuery({
    queryKey: activeCallsKey(ws),
    queryFn: ({ signal }) => api.sip.activeCalls(ws, signal),
    enabled: manage,
    select: (d) => {
      const a = d.calls.find((c) => c.call?.id === id);
      return a ? `${a.step}|${a.stepName}` : '';
    },
  });
  const [step, name = ''] = (q.data ?? '').split('|');
  return <>{liveText(ws, e, step ? { step: asEnum(SipActiveStep, Number(step)), name } : null)}</>;
}

/** The party's circle: the employee's avatar, the contact's initials, or a handset; the direction badge at the corner. */
export function PartyCircle({ e, ws, name, size, ring, badge: withBadge = true }: { e: SipJournalEntry; ws: string; name: string; size: number; ring: string; badge?: boolean }): ReactNode {
  const avatar = useWorkspaces((s) => (e.memberUserId ? (s.byId[ws]?.members[e.memberUserId]?.user?.avatarFileId ?? '') : ''));
  const dir = directionOf(e);
  const badge = !withBadge || size >= 56 ? 0 : size >= 40 ? 16 : 14;
  const contact = !!e.contact && !!(e.contact.name || e.contact.company);
  return (
    <span className="pointer-events-none relative shrink-0" style={{ width: size, height: size }}>
      {e.memberUserId ? (
        <Avatar userId={e.memberUserId} name={name} fileId={avatar || undefined} size={size} />
      ) : contact ? (
        <span className="grid size-full place-items-center rounded-full font-semibold text-white" style={{ background: avatarColor(e.contact?.id || name), fontSize: Math.round(size * 0.36) }} aria-hidden>
          {workspaceInitials(name)}
        </span>
      ) : (
        <span className="grid size-full place-items-center rounded-full bg-[var(--color-fill)] text-muted" aria-hidden>
          <Phone style={{ width: size * 0.45, height: size * 0.45 }} strokeWidth={1.75} />
        </span>
      )}
      {badge ? (
        <span
          className={cx('absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full border-2', dir === 'missed' ? 'bg-danger-fill text-white' : 'bg-[var(--color-popover-solid)] text-fg')}
          style={{ width: badge + 4, height: badge + 4, borderColor: ring }}
          role="img"
          aria-label={t(dir === 'missed' ? 'tel.dir.missed' : dir === 'in' ? 'tel.dir.in' : 'tel.dir.out')}
          data-dir={dir}
        >
          {dir === 'missed' ? <PhoneMissed style={{ width: badge - 6, height: badge - 6 }} strokeWidth={2.25} aria-hidden /> : dir === 'in' ? <ArrowDownLeft style={{ width: badge - 4, height: badge - 4 }} strokeWidth={2.5} aria-hidden /> : <ArrowUpRight style={{ width: badge - 4, height: badge - 4 }} strokeWidth={2.5} aria-hidden />}
        </span>
      ) : null}
    </span>
  );
}

/** The row's menu: right click on the desktop, a long press on the phone (lib/phoneMenus: a centred card). */
function RowMenu({ e, ws, children }: { e: SipJournalEntry; ws: string; children: ReactNode }): ReactNode {
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-60')} data-testid="tel-row-menu">
          <RowMenuItems e={e} ws={ws} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function RowMenuItems({ e, ws }: { e: SipJournalEntry; ws: string }): ReactNode {
  const id = e.call?.id ?? '';
  const callable = useCallable(e, ws);
  const hasContact = !!e.contact?.id;
  // «Прослушать запись»: the list entry does not say whether a recording exists (and I may hear
  // it) — the menu (mounted only while open) asks the detail, cached for the detail screen too.
  const rec = useQuery({ queryKey: journalEntryKey(ws, id), queryFn: ({ signal }) => api.sip.journalEntry(ws, id, signal), enabled: !!id, select: (d) => d.recording }).data;
  return (
    <>
      {callable ? (
        <ContextMenu.Item className={menuItem} onSelect={() => callBack(e, ws)} data-testid="tel-menu-call">
          <Phone className="size-4" aria-hidden /> {t('tel.call')}
        </ContextMenu.Item>
      ) : null}
      <ContextMenu.Item className={menuItem} onSelect={() => openCallDetail(id)} data-testid="tel-menu-details">
        <Info className="size-4" aria-hidden /> {t('tel.details')}
      </ContextMenu.Item>
      {numberOf(e) ? (
        <ContextMenu.Item className={menuItem} onSelect={() => openOrAddContact(e)} data-testid="tel-menu-contact">
          {hasContact ? <UserRound className="size-4" aria-hidden /> : <UserRoundPlus className="size-4" aria-hidden />} {hasContact ? t('telc.openContact') : t('telc.addContact')}
        </ContextMenu.Item>
      ) : null}
      {rec ? (
        <ContextMenu.Item
          className={menuItem}
          onSelect={() => {
            openCallDetail(id);
            toggleRecording(id, rec, partyName(ws, e).name);
          }}
          data-testid="tel-menu-recording"
        >
          <Play className="size-4" aria-hidden /> {t('tel.recording.play')}
        </ContextMenu.Item>
      ) : null}
      {numberOf(e) ? (
        <ContextMenu.Item className={menuItem} onSelect={() => copyNumber(e)} data-testid="tel-menu-copy">
          <Copy className="size-4" aria-hidden /> {t('tel.copy')}
        </ContextMenu.Item>
      ) : null}
      {e.memberUserId ? (
        <ContextMenu.Item className={menuItem} onSelect={() => writeTo(e)}>
          <MessageCircle className="size-4" aria-hidden /> {t('tel.write')}
        </ContextMenu.Item>
      ) : null}
    </>
  );
}

/** The actions under a swiped row (88 px each, the whole height); mounted only while the row is open. */
function SwipeActions({ e, width, close, copy }: { e: SipJournalEntry; width: number; close: () => void; copy: boolean }): ReactNode {
  const action = 'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 overflow-hidden px-1 text-center text-micro font-medium';
  return (
    <div className="absolute inset-y-0 right-0 flex overflow-hidden" style={{ width }} data-testid="tel-swipe">
      {copy ? (
        <button
          type="button"
          className={cx(action, 'bg-accent-strong text-accent-fg')}
          onClick={() => {
            close();
            openOrAddContact(e);
          }}
          data-testid="tel-swipe-contact"
        >
          {e.contact?.id ? <UserRound className="size-4 shrink-0" aria-hidden /> : <UserRoundPlus className="size-4 shrink-0" aria-hidden />}
          <span className="line-clamp-2">{t('telc.contactShort')}</span>
        </button>
      ) : (
        <button
          type="button"
          className={cx(action, 'bg-accent-strong text-accent-fg')}
          onClick={() => {
            close();
            openCallDetail(e.call?.id ?? '');
          }}
          data-testid="tel-swipe-details"
        >
          <Info className="size-4 shrink-0" aria-hidden />
          <span className="line-clamp-2">{t('tel.details')}</span>
        </button>
      )}
      {copy ? (
        <button
          type="button"
          className={cx(action, 'bg-[var(--color-fill-hover)] text-fg')}
          onClick={() => {
            close();
            copyNumber(e);
          }}
          data-testid="tel-swipe-copy"
        >
          <Copy className="size-4 shrink-0" aria-hidden />
          <span className="line-clamp-2">{t('tel.copyShort')}</span>
        </button>
      ) : null}
    </div>
  );
}

import type { CallCard } from '@calaba/protocol';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { callLogLine, callTimer } from '../../lib/callModel';
import { fmt, toDate } from '../../lib/format';
import { hangup, startCall } from '../../services/call';
import { useCall } from '../../stores/call';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';
import { useNow } from '../shell/voiceFormat';
import { useCanCall } from '../dm/canDm';

/**
 * Small pieces of the one-to-one call UI (ADR-0034, docs/08 «Звонок»): presence «На звонке», the
 * DM header's call button / in-call pill with its timer, and the DM call log line. Each one
 * subscribes to its own primitive (by user / room id): a tick or a presence change re-renders
 * only the leaf that shows it.
 */

/** The user is in a one-to-one call now (Presence.on_call). */
export function useOnCall(userId: string): boolean {
  return useWorkspaces((s) => s.presences[userId]?.onCall === true);
}

/** The phone after a name: «На звонке» (tooltip / label). Renders nothing otherwise. */
export function OnCallMark({ userId, className }: { userId: string; className?: string }): ReactNode {
  const on = useOnCall(userId);
  if (!on) return null;
  return <Phone className={cx('size-3.5 shrink-0 text-ok', className)} role="img" aria-label={t('call.onCall')} data-testid="on-call-mark" />;
}

/** «Звонок · 00:42»: the only part that ticks (a leaf with its own 1 s clock, docs/14). */
function CallTimer({ since }: { since: number }): ReactNode {
  const now = useNow(1000);
  return <span className="tabular-nums">{callTimer((now - since) / 1000)}</span>;
}

/**
 * The DM header's call slot: in this DM's call — the green «Звонок · 00:42» and a red
 * «Завершить»; otherwise the phone button (hidden for whom I cannot call).
 */
export function DmCallSlot({ roomId, peerId, className }: { roomId: string; peerId: string; className?: string | undefined }): ReactNode {
  const active = useCall((s) => s.phase === 'active' && s.call?.dmRoomId === roomId);
  const since = useCall((s) => s.since);
  const canCall = useCanCall(peerId);
  if (active && since !== null) {
    return (
      <span className="flex shrink-0 items-center gap-2 pr-1" data-testid="dm-call-active">
        <span className="flex items-center gap-1.5 text-body font-semibold text-ok" role="timer" aria-live="off">
          <Phone className="size-4" aria-hidden />
          {t('call.inCall')} · <CallTimer since={since} />
        </span>
        <button
          type="button"
          onClick={() => void hangup()}
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-danger-fill px-3 mobile:px-4 text-body font-semibold text-white transition-[filter] duration-[var(--motion-fast)] hover:brightness-110"
          data-testid="dm-call-hangup"
        >
          <Phone className="size-4 rotate-[135deg]" aria-hidden />
          {t('call.hangup')}
        </button>
      </span>
    );
  }
  if (!canCall) return null;
  return (
    <IconButton label={t('call.call')} onClick={() => void startCall(peerId)} className={className} data-testid="dm-call">
      <Phone className="size-[18px]" />
    </IconButton>
  );
}

/**
 * The DM call log line (SystemMessage.call), like Telegram: a phone arrow and «Исходящий звонок ·
 * 5:12» / «Пропущенный звонок» (red for the callee) with the time; on the caller's side (right) or
 * the other's (left). Memo; subscribes to my id only.
 */
export const CallLogRow = memo(function CallLogRow({ card, at }: { card: CallCard; at: Timestamp | undefined }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const line = callLogLine(card, me);
  const Icon = line.missed ? PhoneMissed : line.dir === 'out' ? PhoneOutgoing : PhoneIncoming;
  return (
    <div className={cx('flex', line.dir === 'out' ? 'justify-end' : 'justify-start pl-11')} data-testid="call-log">
      <div className="flex items-center gap-2 rounded-[var(--radius-bubble,16px)] bg-[var(--color-fill)] px-3 py-1.5 text-body">
        <Icon className={cx('size-4 shrink-0', line.missed ? 'text-danger' : 'text-muted')} aria-hidden />
        <span className={line.missed ? 'font-medium text-danger-text' : 'text-fg'}>{line.text}</span>
        <span className="text-caption tabular-nums text-muted">{fmt.time(toDate(at))}</span>
      </div>
    </div>
  );
});

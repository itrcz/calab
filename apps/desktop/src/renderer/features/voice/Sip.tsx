import * as Popover from '@radix-ui/react-popover';
import { SipCallStatus } from '@calaba/protocol';
import { Phone, PhoneOff } from 'lucide-react';
import { memo, useEffect, useId, useState, type ReactNode } from 'react';
import { Button, IconButton, Input, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { can, roomPerms } from '../../lib/permissions';
import { planHas } from '../../lib/plan';
import { formatPhone, isLiveStatus, maskEdit, mayDial, mayHangUp, reasonKey, statusKey, type LiveSipCall } from '../../lib/sip';
import { hangUpSipCall, placeSipCall } from '../../services/sip';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useSipCalls } from '../../stores/sipCalls';
import { useSipDial } from '../../stores/sipDial';
import { useVoice } from '../../stores/voice';
import { isGuest, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { formatDuration, useNow } from '../shell/voiceFormat';

/**
 * Telephony in a voice room (ADR-0046, docs/08 «Телефония»): «Позвонить на номер» (room header;
 * on a phone — the members drawer) and the phone participant row under the room. Selectors are
 * per room and return primitives or the store's own call object; the talk timer is a leaf with
 * its own 1 s clock, mounted only while the line is ACTIVE.
 */

/**
 * Telephony is part of the workspace's plan (Business only, owner 02.10, ADR-0046). A primitive
 * selector. Without it the header button is hidden and the room menu's item shows a lock: only a
 * workspace downgraded with telephony still on gets there (below Business it can't be switched on).
 */
export function useTelephonyOnPlan(workspaceId: string): boolean {
  return useWorkspaces((s) => planHas(s.byId[workspaceId]?.ws.plan, 'telephony'));
}

/**
 * «Позвонить на номер» is offered here (lib/sip mayDial; the server checks the same). `anyCall`:
 * the room menu's item — the same rules without «I am in this room's call» (the item joins first).
 */
export function useCanDial(workspaceId: string, roomId: string, anyCall = false): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const sipEnabled = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.sipEnabled);
  const guest = useWorkspaces((s) => isGuest(s.byId[workspaceId]?.members[me]));
  const roles = useMemberRoles(workspaceId, me);
  const room = useRooms((s) => s.byId[roomId]);
  const inCall = useVoice((s) => s.roomId === roomId && (s.phase === 'connected' || s.phase === 'reconnecting'));
  const liveCall = useSipCalls((s) => {
    const c = s.byRoom[roomId];
    return !!c && isLiveStatus(c.status);
  });
  // Cheap until the gate's primitives pass: no permission math for rooms without telephony.
  if (!sipEnabled || !(inCall || anyCall) || liveCall || guest) return false;
  const perms = roomPerms(roles, me, room);
  return mayDial({ sipEnabled, placeCalls: can(perms, 'PLACE_CALLS'), connect: can(perms, 'CONNECT'), guest, inCall: true, liveCall });
}

/**
 * The dial button and its popover: a number field (mask «+7 916 123-45-67», paste-friendly),
 * Enter or «Позвонить» dials; a refusal stays inline under the field. `variant`: the room
 * header's 32 px icon, or a full-width button in the phone's members drawer.
 */
export function SipDialButton({ workspaceId, roomId, variant }: { workspaceId: string; roomId: string; variant: 'header' | 'sheet' }): ReactNode {
  const onPlan = useTelephonyOnPlan(workspaceId);
  const allowed = useCanDial(workspaceId, roomId) && onPlan;
  const [open, setOpen] = useState(false);
  // «Позвонить на номер» from the room menu (stores/sipDial): open once the gate passes (the
  // join it started has connected); a primitive selector, the store never ticks.
  const requested = useSipDial((s) => s.roomId === roomId);
  const consume = requested && allowed;
  if (consume && !open) setOpen(true);
  useEffect(() => {
    if (consume) useSipDial.getState().clear(roomId);
  }, [consume, roomId]);
  if (!allowed) {
    // Left the call / the line went live meanwhile: the popover closes with the button.
    if (open) setOpen(false);
    return null;
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      {variant === 'header' ? (
        <Tip label={t('sip.dial')}>
          <Popover.Trigger asChild>
            <IconButton tip={false} label={t('sip.dial')} active={open} data-testid="sip-dial">
              <Phone className="size-[18px]" />
            </IconButton>
          </Popover.Trigger>
        </Tip>
      ) : (
        <Popover.Trigger asChild>
          <Button variant="secondary" className="mb-3 w-full" data-testid="sip-dial">
            <Phone className="size-4" aria-hidden />
            {t('sip.dial')}
          </Button>
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Content
          align={variant === 'header' ? 'end' : 'center'}
          sideOffset={8}
          collisionPadding={16}
          aria-label={t('sip.dial')}
          className="mat-popover anim-in z-[var(--z-popover)] w-[300px] max-w-[calc(100vw-32px)] rounded-[var(--radius-panel)] p-3"
        >
          <DialForm roomId={roomId} onDone={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function DialForm({ roomId, onDone }: { roomId: string; onDone: () => void }): ReactNode {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const submit = async (): Promise<void> => {
    if (busy || !value.trim()) return;
    setBusy(true);
    const err = await placeSipCall(roomId, value);
    setBusy(false);
    if (err) setError(err);
    else onDone();
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-n`} className="text-body font-semibold">
        {t('sip.dial')}
      </label>
      <Input
        id={`${id}-n`}
        data-testid="sip-number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        autoFocus
        enterKeyHint="go"
        value={value}
        placeholder={t('sip.dial.placeholder')}
        aria-label={t('sip.dial.label')}
        aria-describedby={`${id}-h`}
        aria-invalid={error ? true : undefined}
        className="font-medium tabular-nums"
        onChange={(e) => {
          setValue((prev) => maskEdit(prev, e.target.value));
          if (error) setError(null);
        }}
      />
      {error ? (
        <span id={`${id}-h`} className="text-caption text-danger-text" role="alert" data-testid="sip-dial-error">
          {error}
        </span>
      ) : (
        <span id={`${id}-h`} className="text-caption text-faint">
          {t('sip.dial.hint')}
        </span>
      )}
      <Button type="submit" busy={busy} disabled={!value.replace(/\D/g, '')} className="self-end" data-testid="sip-dial-call">
        <Phone className="size-3.5" aria-hidden />
        {t('sip.dial.call')}
      </Button>
    </form>
  );
}

/**
 * The room's phone line in its participant list (docs/08 «Телефония»): a 40 px two-line row on
 * the participants' grid — a 24 px circle with the handset where the avatar is, the number, and
 * the status line «Набираем… / Звонит… / В разговоре 02:14 / Завершён · причина»; «Завершить» for
 * the caller and MUTE_MEMBERS holders. Drawn from the SipCall (the line has no voice state).
 */
export const SipCallRow = memo(function SipCallRow({ workspaceId, roomId }: { workspaceId: string; roomId: string }): ReactNode {
  const call = useSipCalls((s) => s.byRoom[roomId]);
  if (!call) return null;
  return <SipCallLine workspaceId={workspaceId} call={call} />;
});

function SipCallLine({ workspaceId, call }: { workspaceId: string; call: LiveSipCall }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const roles = useMemberRoles(workspaceId, me);
  const room = useRooms((s) => s.byId[call.roomId]);
  const live = isLiveStatus(call.status);
  const canHang = live && mayHangUp({ me, startedBy: call.startedBy, muteMembers: can(roomPerms(roles, me, room), 'MUTE_MEMBERS'), live });
  const number = formatPhone(call.number);
  const active = call.status === SipCallStatus.ACTIVE;
  return (
    <li
      className={cx('flex h-10 items-center gap-2 rounded-[var(--radius-row)] pl-8 pr-1.5 transition-colors duration-[var(--motion-fast)] hover:bg-hover', !live && 'opacity-70')}
      aria-label={t('sip.row.label', { number })}
      data-testid="sip-call-row"
      data-status={SipCallStatus[call.status].toLowerCase()}
    >
      <span className={cx('grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-fill)]', active ? 'text-ok' : 'text-muted')} aria-hidden>
        <Phone className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-body tabular-nums text-fg" title={number}>
          {number}
        </span>
        <SipStatusLine call={call} />
      </span>
      {canHang ? (
        <IconButton
          label={t('sip.row.hangup')}
          size="sm"
          danger
          className="mobile:tap-size"
          data-testid="sip-hangup"
          onClick={() => void hangUpSipCall(call.roomId, call.id)}
        >
          <PhoneOff className="size-4" />
        </IconButton>
      ) : null}
    </li>
  );
}

function SipStatusLine({ call }: { call: LiveSipCall }): ReactNode {
  const cls = 'truncate text-caption tabular-nums';
  if (call.status === SipCallStatus.ACTIVE) {
    return (
      <span className={cx(cls, 'text-[var(--color-green-text)]')} data-testid="sip-status">
        {t('sip.status.active')} {call.answeredAt ? <SipTalkTime since={call.answeredAt} /> : null}
      </span>
    );
  }
  const text = isLiveStatus(call.status) ? t(statusKey(call.status)) : `${t('sip.status.ended')} · ${t(reasonKey(call.status, call.reason))}`;
  return (
    <span className={cx(cls, 'text-muted')} title={text} data-testid="sip-status">
      {text}
    </span>
  );
}

/** «02:14» since the answer: the only thing that ticks, and only while the line is ACTIVE. */
function SipTalkTime({ since }: { since: number }): ReactNode {
  const now = useNow(1000);
  return <>{formatDuration(Math.max(0, now - since))}</>;
}

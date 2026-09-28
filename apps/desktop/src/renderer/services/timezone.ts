import type { Me } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { fmt, useTimeFormat } from '../lib/format';
import { localTimeZone, timeZoneLabel } from '../lib/timezone';
import { useNow } from '../features/shell/voiceFormat';
import { useSession } from '../stores/session';
import { useWorkspaces } from '../stores/workspaces';

/** The account whose zone was checked in this sign-in (null: not yet / signed out). */
let syncedFor: string | null = null;
/** The device zone last checked for that account (sent, or already in the profile). */
let checkedZone = '';
/** The daily re-check (one timer for the app; set while signed in). */
let daily: ReturnType<typeof setInterval> | null = null;

const DAY = 24 * 60 * 60 * 1000;

/** Sends this device's zone when it is new since the last check and differs from the profile. */
function check(profileZone: string): void {
  const tz = localTimeZone();
  if (!tz || tz === checkedZone) return;
  checkedZone = tz;
  if (profileZone === tz) return;
  void api.me
    .update({ timezone: tz })
    .then((r) => {
      if (r.me) useSession.getState().set({ me: r.me });
    })
    .catch((e: unknown) => log.warn('time zone sync failed', e));
}

/**
 * Once per sign-in (on READY): tell the server this device's IANA zone when the profile has
 * another one (or none) — others see my local time in my profile (User.timezone, docs/09 #48).
 * A failure (422) is not retried for the same zone; another account signed in afterwards is
 * checked too. Then once a day (and on wake-up, recheckTimeZone) — a laptop flown to another zone.
 */
export function syncTimeZone(me: Me | null | undefined): void {
  const user = me?.user;
  if (!user?.id || syncedFor === user.id) return;
  syncedFor = user.id;
  checkedZone = '';
  check(user.timezone);
  daily ??= setInterval(recheckTimeZone, DAY);
}

/** Wake-up / daily: the system zone may have changed since the sign-in — send it if so. */
export function recheckTimeZone(): void {
  if (!syncedFor) return;
  check(useSession.getState().me?.user?.timezone ?? '');
}

/** Sign-out: the next account (or the same one again) gets its zone checked on its READY. */
export function resetTimeZoneSync(): void {
  syncedFor = null;
  checkedZone = '';
  if (daily !== null) clearInterval(daily);
  daily = null;
}

/** «+5 UTC» for a member whose zone differs from mine right now, else null. */
export function useTimeZoneLabel(userId: string): string | null {
  const theirs = useWorkspaces((s) => s.users[userId]?.timezone ?? '');
  return timeZoneLabel(theirs, localTimeZone());
}

/**
 * The member's local time «16:50» (owner, 28.09: the tag next to a name shows the time; the
 * profile keeps «UTC+5 · 16:50»). Only when their zone differs from mine; ticks once a minute
 * on the shared clock (docs/14: one timer per period); 24 / 12 h per the workspace (docs/09 #73).
 */
export function useLocalTimeTag(userId: string): string | null {
  const theirs = useWorkspaces((s) => s.users[userId]?.timezone ?? '');
  const differs = timeZoneLabel(theirs, localTimeZone()) !== null;
  const now = useNow(differs ? 60_000 : 0);
  // The workspace clock format (docs/09 #73) re-renders the tag live.
  useTimeFormat();
  if (!differs) return null;
  try {
    return fmt.timeIn(new Date(now), theirs);
  } catch {
    return null;
  }
}

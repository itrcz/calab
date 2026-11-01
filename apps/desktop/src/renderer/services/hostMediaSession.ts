import type { HostMediaSession, HostMediaSessionCapability } from '../../shared/hostActivity';
import { getLocale, subscribeLocale } from '../i18n';
import { isPhoneRoom } from '../lib/sipInbound';
import { platform } from '../platform';
import { useCall } from '../stores/call';
import { useVoice } from '../stores/voice';
import { voice } from './voice';

/**
 * Tells the Android phone host whether this page is in a voice room or a call, so it holds a
 * microphone foreground service while the app is in the background (board #141). Only the Android
 * host offers the capability; everywhere else this installs nothing. Sent on change only: no
 * timers, and level/speaking/statistics ticks of the voice store cost one string comparison.
 * The host's «Выйти» / «Завершить» leaves the voice session, as the panel's own button does;
 * leaving a call's session hangs the call up (services/call.ts, sipInbound.ts, sipOutbound.ts).
 */
export function installHostMediaSession(capability: HostMediaSessionCapability | undefined = platform.mediaSession): () => void {
  if (!capability) return () => undefined;
  let previous = 'none';
  const update = () => {
    const { roomId, phase } = useVoice.getState();
    const call = useCall.getState();
    const callRoom = call.phase === 'active' ? call.call?.dmRoomId : undefined;
    const session: HostMediaSession = roomId === null || (phase !== 'connected' && phase !== 'reconnecting') ? 'none'
      : roomId === callRoom || isPhoneRoom(roomId) ? 'call' : 'room';
    const language = getLocale() === 'ru' ? 'ru' : 'en';
    const key = session === 'none' ? 'none' : `${session}:${language}`;
    if (key === previous) return;
    previous = key;
    capability.set(session, language);
  };
  const unsubscribers = [
    useVoice.subscribe(update),
    useCall.subscribe(update),
    subscribeLocale(update),
    capability.onLeave(() => { void voice.leave(); }),
  ];
  update();
  return () => { for (const unsub of unsubscribers) unsub(); };
}

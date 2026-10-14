import { HOST_ACTIVITY_HEARTBEAT_MS, type SessionActivityCapability, type SessionActivitySnapshot } from '../../shared/hostActivity';
import { getLocale, subscribeLocale } from '../i18n';
import { platform } from '../platform';
import { useSession } from '../stores/session';
import { useVoice } from '../stores/voice';
import type { VoiceStore } from '../stores/voice';
import type { SessionState } from '../stores/session';

/** Status projection only: no media, requests, tokens, room names or duplicate voice controller. */
export function installHostActivity(capability: SessionActivityCapability | undefined = platform.sessionActivity): () => void {
  if (!capability) return () => undefined;
  let generation = 0;
  let identity: string | null = null;
  let previous = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastVoice: VoiceStore | undefined;
  let lastSession: SessionState | undefined;
  let lastLocale = '';
  let revokedSession: string | null = null;
  const update = (heartbeat = false) => {
    const voice = useVoice.getState();
    const session = useSession.getState();
    const locale = getLocale();
    // Level/speaking/statistics ticks do not allocate snapshots or send bridge traffic.
    if (!heartbeat && lastVoice?.roomId === voice.roomId && lastVoice.joinedAt === voice.joinedAt &&
      lastVoice.phase === voice.phase && lastVoice.muted === voice.muted && lastVoice.deafened === voice.deafened &&
      lastVoice.serverMuted === voice.serverMuted && lastVoice.canSpeak === voice.canSpeak &&
      lastSession?.status === session.status && lastSession.sessionId === session.sessionId && lastLocale === locale) return;
    lastVoice = voice;
    lastSession = session;
    lastLocale = locale;
    const authenticated = (session.status === 'authed' || session.status === 'offline') && session.sessionId !== revokedSession;
    const active = authenticated && voice.roomId !== null && (voice.phase === 'connected' || voice.phase === 'reconnecting');
    // Identity stays local: the host gets a counter, never Calab room/session identifiers.
    const nextIdentity = active ? `${session.sessionId}:${voice.roomId}:${String(voice.joinedAt)}` : null;
    if (identity !== nextIdentity) { identity = nextIdentity; generation++; }
    if (!active && timer !== undefined) { clearInterval(timer); timer = undefined; }
    if (active && timer === undefined) timer = setInterval(() => update(true), HOST_ACTIVITY_HEARTBEAT_MS);
    const snapshot: SessionActivitySnapshot = {
      generation, status: active ? (voice.phase === 'reconnecting' ? 'reconnecting' : 'connected') : 'ended',
      muted: voice.muted || voice.deafened || voice.serverMuted || !voice.canSpeak,
      language: locale === 'ru' ? 'ru' : 'en',
    };
    const encoded = JSON.stringify(snapshot);
    if (!authenticated) { previous = ''; capability.clear(); return; }
    if (encoded === previous && !heartbeat) return;
    previous = encoded;
    capability.publish(snapshot);
  };
  const unsubscribers = [useVoice.subscribe(() => update()), useSession.subscribe(() => update()), subscribeLocale(() => update()),
    platform.auth.onLoggedOut(() => {
      revokedSession = useSession.getState().sessionId;
      if (timer !== undefined) { clearInterval(timer); timer = undefined; }
      capability.clear('logout');
    })];
  const clear = () => capability.clear();
  window.addEventListener('pagehide', clear);
  update();
  return () => {
    for (const unsub of unsubscribers) unsub();
    if (timer !== undefined) clearInterval(timer);
    window.removeEventListener('pagehide', clear);
    capability.clear();
  };
}

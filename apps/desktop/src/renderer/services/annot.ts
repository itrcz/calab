import { Track, type Participant, type Room } from 'livekit-client';
import type { AnnotOverlayTarget } from '../../shared/annot';
import { ANNOT_TOPIC, decodeAnnot, encodeAnnot, type AnnotWire } from '../lib/annot/codec';
import { RateLimiter, SeqGuard } from '../lib/annot/limits';
import { colorFor } from '../lib/annot/paint';
import { grantAllowsAnnot } from '../lib/annot/permission';
import { AnnotScene, type SceneEvent } from '../lib/annot/scene';
import { AnnotSender, type OutMessage } from '../lib/annot/sender';
import { log } from '../lib/log';
import { isWeb, platform } from '../platform';
import { setAnnot, useAnnot } from '../stores/annot';
import { useVoice, type RemoteStream } from '../stores/voice';
import { memberName } from '../stores/workspaces';

/**
 * Screen-share annotations (ADR-0028): laser pointer and pen of the viewers over a stream.
 * LiveKit data, reliable, topic `annot`, protobuf. Receivers drop anything that is malformed,
 * over 30 msg/s per sender, out of order, for a stream that is not live, while the presenter
 * forbids it, or from a sender whose LiveKit grant has no microphone (no SPEAK in the room).
 * The presenter's own stream is also drawn on the click-through overlay over the shared screen
 * (desktop, whole screens only: main/annotOverlay.ts).
 */

const idOf = (identity: string): string => identity.split(':')[0] ?? identity;

type Listener = () => void;

type OverlayState = 'closed' | 'opening' | 'open' | 'unavailable';

/** The presenter's «X рисует» indicator goes after this long without annotations. */
export const ACTIVITY_MS = 4000;

/**
 * Where the presenter sees annotations of a stream of this source: the overlay covers whole
 * screens in the desktop app (main decides about the OS); otherwise only the stream's preview.
 */
export function viewFor(target: AnnotOverlayTarget | null | undefined, web: boolean): 'screen' | 'preview' {
  return !web && target ? 'screen' : 'preview';
}

class AnnotService {
  private room: Room | null = null;
  private readonly scenes = new Map<string, AnnotScene>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly limiter = new RateLimiter();
  private readonly seqs = new SeqGuard();
  private seq = 0;
  private readonly sender = new AnnotSender((m) => this.publish(m));
  /** My stream (track sid) and the source it captures, for the overlay. */
  private mine: { sid: string; target: AnnotOverlayTarget | null } | null = null;
  private overlay: OverlayState = 'closed';
  private overlayQueue: SceneEvent[] = [];
  /** Last annotation of my stream by someone else (performance.now), and the indicator's timer. */
  private activityAt = 0;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  /** The first annotation of my stream is logged with the overlay state (issue #102). */
  private loggedFirst = false;

  // ---------------------------------------------------------------- lifecycle (services/voice.ts)

  attach(room: Room): void {
    this.detach();
    this.room = room;
  }

  /** Left the call: everything goes. */
  detach(): void {
    this.room = null;
    this.sender.reset();
    this.limiter.reset();
    this.seqs.reset();
    this.seq = 0;
    for (const sid of [...this.scenes.keys()]) this.dropScene(sid);
    this.presenting(null);
    setAnnot({ policy: {}, tool: 'none' });
  }

  /** The room's streams changed: scenes of streams that ended go (ADR-0028 §4). */
  syncStreams(streams: readonly RemoteStream[]): void {
    const live = new Set(streams.map((s) => s.trackSid));
    for (const sid of [...this.scenes.keys()]) if (!live.has(sid)) this.dropScene(sid);
    const policy = useAnnot.getState().policy;
    if (Object.keys(policy).some((sid) => !live.has(sid))) {
      setAnnot({ policy: Object.fromEntries(Object.entries(policy).filter(([sid]) => live.has(sid))) });
    }
  }

  participantLeft(identity: string): void {
    this.limiter.forget(identity);
    this.seqs.forget(identity);
    for (const [sid, scene] of this.scenes) {
      scene.forget(identity);
      this.notify(sid);
    }
  }

  /**
   * I started (sid + the captured source) or stopped (null) streaming. The overlay opens lazily,
   * on the first annotation; a window source gets none (ADR-0028 §9).
   */
  presenting(sid: string | null, target?: AnnotOverlayTarget | null): void {
    if (this.mine && this.mine.sid !== sid) this.closeOverlay();
    if (this.mine?.sid !== sid) {
      this.endActivity();
      this.loggedFirst = false;
    }
    this.mine = sid ? { sid, target: target ?? null } : null;
    if (sid) setAnnot({ mineView: viewFor(target, isWeb) });
    // Late viewers get the policy when they announce watching; tell the room about a «no» now.
    if (sid && !useAnnot.getState().allowMine) this.sendPolicy(sid, false);
  }

  /**
   * LiveKit republished my stream under a new track sid (a full reconnect: livekit-client
   * `republishAllTracks`). Viewers annotate the new sid from now on; without this the presenter
   * dropped every annotation as «not a live stream» for the rest of the stream (issue #102).
   * The source, the overlay and the policy stay.
   */
  republished(sid: string): void {
    const mine = this.mine;
    if (!mine || mine.sid === sid) return;
    this.dropScene(mine.sid);
    this.mine = { ...mine, sid };
    if (!useAnnot.getState().allowMine) this.sendPolicy(sid, false);
  }

  // ---------------------------------------------------------------- receive

  onData(payload: Uint8Array, from: Participant): void {
    const room = this.room;
    if (!room) return;
    const m = decodeAnnot(payload);
    if (!m) return;
    const now = performance.now();
    if (!this.limiter.take(from.identity, now) || !this.seqs.accept(from.identity, m.seq)) return;
    const owner = this.ownerOf(m.streamSid);
    if (owner === null) return; // not a live stream of this room
    if (m.kind === 'policy') {
      if (from.identity !== owner) return;
      this.onPolicy(m.streamSid, m.allow);
      return;
    }
    if (!this.allowed(m.streamSid)) return;
    if (!grantAllowsAnnot(from.permissions)) return;
    this.apply(m.streamSid, this.toEvent(m, from.identity, from.identity === owner));
  }

  /** The presenter's identity of a live stream, or null. */
  private ownerOf(sid: string): string | null {
    const room = this.room;
    if (!room) return null;
    if (this.mine?.sid === sid) return room.localParticipant.identity;
    for (const p of room.remoteParticipants.values()) {
      if (p.getTrackPublicationBySid(sid)?.source === Track.Source.ScreenShare) return p.identity;
    }
    return null;
  }

  private allowed(sid: string): boolean {
    if (this.mine?.sid === sid) return useAnnot.getState().allowMine;
    return useAnnot.getState().policy[sid] !== false;
  }

  private onPolicy(sid: string, allow: boolean): void {
    const st = useAnnot.getState();
    if (st.policy[sid] !== allow) setAnnot({ policy: { ...st.policy, [sid]: allow } });
    if (!allow) {
      this.scenes.get(sid)?.clear();
      this.notify(sid);
      if (useVoice.getState().watching === sid) setAnnot({ tool: 'none' });
    }
  }

  private toEvent(m: AnnotWire, identity: string, owner: boolean): SceneEvent {
    const kind = m.kind === 'policy' ? 'clear' : m.kind;
    return { from: identity, name: memberName(useVoice.getState().workspaceId, idOf(identity)), kind, color: m.color, points: m.points, strokeId: m.strokeId, strokeEnd: m.strokeEnd, owner };
  }

  private apply(sid: string, ev: SceneEvent): void {
    this.scene(sid).apply(ev, performance.now());
    this.notify(sid);
    if (this.mine?.sid === sid) {
      this.toOverlay(ev);
      if (ev.from !== this.room?.localParticipant.identity) this.noteActivity(ev);
    }
  }

  /** Someone annotates my stream: the panel says who, whether or not the overlay shows it. */
  private noteActivity(ev: SceneEvent): void {
    if (ev.kind === 'clear') return;
    if (!this.loggedFirst) {
      this.loggedFirst = true;
      log.info('annot: first annotation of my stream', { kind: ev.kind, from: ev.from, overlay: this.overlay, target: this.mine?.target ?? null, web: isWeb });
    }
    this.activityAt = performance.now();
    const cur = useAnnot.getState().mineActivity;
    if (cur?.name !== ev.name || cur.kind !== ev.kind) setAnnot({ mineActivity: { name: ev.name, kind: ev.kind } });
    if (this.activityTimer === null) this.scheduleActivityEnd(ACTIVITY_MS);
  }

  /** One timer while someone annotates (none when quiet): re-armed for what is left. */
  private scheduleActivityEnd(ms: number): void {
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      const left = this.activityAt + ACTIVITY_MS - performance.now();
      if (left > 50) this.scheduleActivityEnd(left);
      else setAnnot({ mineActivity: null });
    }, ms);
  }

  private endActivity(): void {
    if (this.activityTimer !== null) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    if (useAnnot.getState().mineActivity) setAnnot({ mineActivity: null });
  }

  // ---------------------------------------------------------------- send (the stream's tools)

  /** I may annotate this stream: someone else's, live, allowed by its presenter, I have SPEAK. */
  canAnnotate(stream: RemoteStream | undefined, canSpeak: boolean, policy: Record<string, boolean>): boolean {
    return !!stream && !stream.local && canSpeak && policy[stream.trackSid] !== false && this.room !== null;
  }

  myColor(): number {
    return useAnnot.getState().color ?? colorFor(idOf(this.room?.localParticipant.identity ?? ''));
  }

  pointer(sid: string, x: number, y: number): void {
    this.sender.movePointer(sid, this.myColor(), x, y);
  }

  strokeStart(sid: string, x: number, y: number): void {
    this.sender.startStroke(sid, this.myColor(), x, y);
  }

  strokeMove(x: number, y: number): void {
    this.sender.moveStroke(x, y);
  }

  strokeEnd(): void {
    this.sender.endStroke();
  }

  /** «Очистить»: my strokes on this stream (the presenter's clear — everyone's). */
  clear(sid: string): void {
    this.sender.clear(sid, this.myColor());
  }

  private publish(m: OutMessage): void {
    const room = this.room;
    if (!room) return;
    const me = room.localParticipant;
    const bytes = encodeAnnot({ ...m, seq: ++this.seq, allow: false });
    if (!bytes) return;
    void me.publishData(bytes, { reliable: true, topic: ANNOT_TOPIC }).catch((e: unknown) => log.debug('annot publish failed', e));
    // LiveKit does not echo data back: draw my own at once.
    this.apply(m.streamSid, { from: me.identity, name: memberName(useVoice.getState().workspaceId, idOf(me.identity)), kind: m.kind, color: m.color, points: m.points, strokeId: m.strokeId, strokeEnd: m.strokeEnd, owner: this.mine?.sid === m.streamSid });
  }

  // ---------------------------------------------------------------- presenter

  /** The switch in my stream's panel: viewers may / may not annotate my stream. */
  setAllowMine(allow: boolean): void {
    setAnnot({ allowMine: allow });
    const sid = this.mine?.sid;
    if (!sid) return;
    this.sendPolicy(sid, allow);
    if (!allow) {
      this.scenes.get(sid)?.clear();
      this.notify(sid);
      this.closeOverlay();
      this.endActivity();
    }
  }

  /** «Стереть рисунки» in my stream's panel: my clear erases everyone's strokes. */
  clearMine(): void {
    const sid = this.mine?.sid;
    if (sid) this.clear(sid);
  }

  /** A viewer started watching my stream (calaba.watch): tell them the policy. */
  viewerJoined(identity: string, sid: string): void {
    if (this.mine?.sid === sid) this.sendPolicy(sid, useAnnot.getState().allowMine, identity);
  }

  private sendPolicy(sid: string, allow: boolean, to?: string): void {
    const room = this.room;
    if (!room) return;
    const bytes = encodeAnnot({ streamSid: sid, kind: 'policy', color: 0, points: [], seq: ++this.seq, strokeId: 0, strokeEnd: false, allow });
    if (!bytes) return;
    void room.localParticipant
      .publishData(bytes, { reliable: true, topic: ANNOT_TOPIC, ...(to ? { destinationIdentities: [to] } : {}) })
      .catch((e: unknown) => log.debug('annot policy failed', e));
  }

  private toOverlay(ev: SceneEvent): void {
    const target = this.mine?.target;
    if (!target || this.overlay === 'unavailable') return;
    if (this.overlay === 'open') {
      platform.annotOverlay.send(ev);
      return;
    }
    if (this.overlayQueue.length < 64) this.overlayQueue.push(ev);
    if (this.overlay === 'opening') return;
    this.overlay = 'opening';
    const sid = this.mine?.sid;
    void platform.annotOverlay
      .open(target)
      .catch(() => false)
      .then((ok) => {
        if (this.mine?.sid !== sid || this.overlay !== 'opening') return;
        this.overlay = ok ? 'open' : 'unavailable';
        if (!ok) {
          // Issue #102: no window over the screen (Linux, no display for the source): the panel
          // points to the preview instead of promising the overlay.
          log.info('annot: overlay unavailable, preview only', { target });
          setAnnot({ mineView: 'preview' });
        }
        const queued = this.overlayQueue;
        this.overlayQueue = [];
        if (ok) for (const e of queued) platform.annotOverlay.send(e);
      });
  }

  private closeOverlay(): void {
    if (this.overlay === 'open' || this.overlay === 'opening') platform.annotOverlay.close();
    this.overlay = 'closed';
    this.overlayQueue = [];
  }

  // ---------------------------------------------------------------- scenes (the canvas layers)

  scene(sid: string): AnnotScene {
    let s = this.scenes.get(sid);
    if (!s) {
      s = new AnnotScene();
      this.scenes.set(sid, s);
    }
    return s;
  }

  /** Called after every change of the stream's scene (the layer kicks its paint loop). */
  subscribe(sid: string, cb: Listener): () => void {
    let set = this.listeners.get(sid);
    if (!set) {
      set = new Set();
      this.listeners.set(sid, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (!set.size) this.listeners.delete(sid);
    };
  }

  private notify(sid: string): void {
    for (const cb of this.listeners.get(sid) ?? []) cb();
  }

  /** A mounted layer keeps its scene object: then it is only emptied, not forgotten. */
  private dropScene(sid: string): void {
    this.scenes.get(sid)?.clear();
    this.notify(sid);
    if (!this.listeners.get(sid)?.size) this.scenes.delete(sid);
  }
}

export const annot = new AnnotService();

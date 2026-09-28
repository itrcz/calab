import { createRequire } from 'node:module';
import { chromium, type Browser } from '@playwright/test';
import { AccessToken } from 'livekit-server-sdk';
import { livekitRoomPrefix } from '../e2e-support/mock-server';

/**
 * A second LiveKit participant that publishes a *static* screen-share (or camera) track — a
 * canvas with flat colour blocks — so the stream stage, the PiP and the video tiles can be
 * photographed deterministically. Joins the same LiveKit room the mock server hands out
 * (`mock_<roomId>`, prefix MOCK_LIVEKIT_ROOM_PREFIX). The client's own camera is Chromium's fake
 * device (CALABA_FAKE_MEDIA). `image` (a 1280×720 PNG) replaces the colour blocks (marketing
 * screenshots only).
 */
const LK_URL = process.env['MOCK_LIVEKIT_URL'] ?? 'ws://127.0.0.1:7880';
const LK_KEY = process.env['MOCK_LIVEKIT_KEY'] ?? 'devkey';
const LK_SECRET = process.env['MOCK_LIVEKIT_SECRET'] ?? 'secret';

/** A LiveKit data packet the participant received (screen-share annotations, ADR-0028). */
export interface ReceivedData {
  topic: string;
  from: string;
  data: number[];
}

export interface Publisher {
  stop(): Promise<void>;
  /** The published track's sid ('' for `source: 'none'`). */
  trackSid(): Promise<string>;
  /** Someone else's screen share in the room (the stream a viewer annotates), '' if none. */
  remoteScreenSid(): Promise<string>;
  /** Data packets received so far (only with `data: true`). */
  received(): Promise<ReceivedData[]>;
  /** Publishes a reliable data packet to the room. */
  send(data: Uint8Array, topic: string): Promise<void>;
}

export async function startPublisher(args: {
  userId: string;
  name: string;
  roomId: string;
  /**
   * 'none': joins without publishing (a data-only participant: a viewer who annotates).
   * 'microphone': a voice — a steady 440 Hz tone as the Microphone source (deafen e2e).
   */
  source?: 'screen' | 'camera' | 'none' | 'microphone';
  image?: Buffer;
  /** Receive data packets (annotations): needs canSubscribe; nothing is subscribed automatically. */
  data?: boolean;
}): Promise<Publisher> {
  const camera = args.source === 'camera';
  const none = args.source === 'none';
  const mic = args.source === 'microphone';
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity: `${args.userId}:${camera ? 'camera' : none ? 'viewer' : mic ? 'mic' : 'publisher'}`, name: args.name, ttl: '10m' });
  // A viewer who annotates has SPEAK (the microphone source) like any member (ADR-0028).
  at.addGrant({ roomJoin: true, room: `${livekitRoomPrefix()}${args.roomId}`, canPublish: true, canSubscribe: args.data === true, canPublishData: true });
  const token = await at.toJwt();
  const browser: Browser = await chromium.launch({ args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const umd = createRequire(import.meta.url).resolve('livekit-client');
  await page.addScriptTag({ path: umd.replace(/[^/]+$/, 'livekit-client.umd.js') });
  await page.evaluate(
    async ({ url, token, camera, none, mic, image }) => {
      const LK = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient;
      const got: Array<{ topic: string; from: string; data: number[] }> = [];
      (window as unknown as { __data: typeof got }).__data = got;
      if (mic) {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 440;
        osc.connect(dest);
        osc.start();
        await ctx.resume();
        const tone = dest.stream.getAudioTracks()[0];
        if (!tone) throw new Error('no tone track');
        const room = new LK.Room();
        (window as unknown as { __room: unknown }).__room = room;
        await room.connect(url, token, { autoSubscribe: false });
        await room.localParticipant.publishTrack(tone, { source: LK.Track.Source.Microphone });
        return;
      }
      if (none) {
        const room = new LK.Room();
        (window as unknown as { __room: unknown }).__room = room;
        room.on(LK.RoomEvent.DataReceived, (payload, p, _k, topic) => got.push({ topic: topic ?? '', from: p?.identity ?? '', data: [...payload] }));
        await room.connect(url, token, { autoSubscribe: false });
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2d context');
      const picture = image ? new Image() : null;
      if (picture && image) {
        picture.src = image;
        await picture.decode();
      }
      // Redraw periodically: an unchanging canvas may stop producing frames.
      const draw = (): void => {
        if (picture) {
          g.drawImage(picture, 0, 0, 1280, 720);
          return;
        }
        g.fillStyle = '#2b2d31';
        g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#0a84ff';
        g.fillRect(80, 80, 520, 300);
        g.fillStyle = '#30d158';
        g.fillRect(680, 80, 520, 300);
        g.fillStyle = '#ececf0';
        g.fillRect(80, 460, 1120, 40);
        g.fillRect(80, 540, 800, 40);
      };
      draw();
      setInterval(draw, 200);
      const track = canvas.captureStream(5).getVideoTracks()[0];
      if (!track) throw new Error('no canvas track');
      const room = new LK.Room();
      (window as unknown as { __room: unknown }).__room = room;
      room.on(LK.RoomEvent.DataReceived, (payload, p, _k, topic) => got.push({ topic: topic ?? '', from: p?.identity ?? '', data: [...payload] }));
      await room.connect(url, token, { autoSubscribe: false });
      await room.localParticipant.publishTrack(track, { source: camera ? LK.Track.Source.Camera : LK.Track.Source.ScreenShare, simulcast: false, videoCodec: 'vp8' });
    },
    { url: LK_URL, token, camera, none, mic, image: args.image ? `data:image/png;base64,${args.image.toString('base64')}` : '' },
  );
  type Win = { __room: import('livekit-client').Room; __data: ReceivedData[] };
  return {
    trackSid: () =>
      page.evaluate(() => {
        const room = (window as unknown as Win).__room;
        const pub = [...room.localParticipant.trackPublications.values()][0];
        return pub?.trackSid ?? '';
      }),
    remoteScreenSid: () =>
      page.evaluate(() => {
        const room = (window as unknown as Win).__room;
        const screen = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient.Track.Source.ScreenShare;
        for (const p of room.remoteParticipants.values()) {
          for (const pub of p.trackPublications.values()) if (pub.source === screen) return pub.trackSid;
        }
        return '';
      }),
    received: () => page.evaluate(() => [...(window as unknown as Win).__data]),
    send: (data, topic) =>
      page.evaluate(
        async ({ bytes, topic }) => {
          await (window as unknown as Win).__room.localParticipant.publishData(new Uint8Array(bytes), { reliable: true, topic });
        },
        { bytes: [...data], topic },
      ),
    async stop() {
      // Leave explicitly: a closed browser lingers in the LiveKit room until its timeout.
      await page.evaluate(() => (window as unknown as { __room?: { disconnect(): Promise<void> } }).__room?.disconnect()).catch(() => undefined);
      await browser.close();
    },
  };
}

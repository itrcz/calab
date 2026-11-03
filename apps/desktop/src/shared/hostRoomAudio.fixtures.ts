import { ROOM_AUDIO_CUES, ROOM_AUDIO_MAX_TOKEN, ROOM_AUDIO_MAX_URL, ROOM_AUDIO_MAX_USERS, ROOM_AUDIO_MAX_WATCHED } from './hostRoomAudio';

/**
 * Cases of the room audio operation, shared by hostRoomAudio.test.ts and
 * apps/mobile/src/roomAudioWire.test.ts. TS judges the whole bridge message, the operation in its
 * envelope, and enforces the exact byte bound there. Swift judges the operation alone, with a higher
 * ceiling as a second line. ACCEPTED: both accept. REJECTED: both reject. OVER_MESSAGE_BOUND: inside
 * every field bound, so only TS rejects it, for the size of the whole message.
 */
type Fixture = Record<string, unknown>;

export const connectionId = '22222222-2222-4222-8222-222222222222';
export const roomId = '33333333-3333-4333-8333-333333333333';
const user = (i: number) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`;
export const users = (count: number, volume = 1) => Object.fromEntries(Array.from({ length: count }, (_, i) => [user(i), volume]));
export const watched = (count: number, volume = 1) => users(count, volume);
export const jwt = (length: number) => `a.${'x'.repeat(length - 4)}.b`;
export const url = (length: number) => `wss://rtc.example.test/${'p'.repeat(length - 23)}`;

export const gate = { mode: 'voice', thresholdDb: -50, pttOpen: false };
export const controls = { muted: false, deafened: false, volume: 1, userVolumes: {}, bitrate: 32000, gate, watched: {}, levels: false };
export const connect = {
  operation: 'connect', connectionId, roomId, url: 'wss://rtc.example.test', token: 'header.payload.signature',
  relayOnly: false, red: true, canSpeak: true, controls,
};
export const control = { operation: 'control', connectionId, controls };
export const cue = { operation: 'cue', connectionId, cue: 'join', volume: 1 };
export const disconnect = { operation: 'disconnect', connectionId };

const withControls = (change: object) => ({ ...control, controls: { ...controls, ...change } });
const withGate = (change: object) => withControls({ gate: { ...gate, ...change } });

export const ACCEPTED: Fixture[] = [
  { operation: 'status' }, connect, control, cue, disconnect,
  ...ROOM_AUDIO_CUES.map(name => ({ ...cue, cue: name })),
  { ...connect, url: url(ROOM_AUDIO_MAX_URL) },
  { ...connect, url: 'wss://rtc.example.test:7880/rtc/v1' },
  { ...connect, url: 'wss://rtc.example.test:1' },
  { ...connect, url: 'wss://rtc.example.test:65535/' },
  { ...connect, url: 'wss://127.0.0.1:7880' },
  { ...connect, url: 'wss://a-b.c-d.example.test' },
  { ...connect, url: 'wss://rtc.example.test/.well-known/rtc/' },
  { ...connect, url: 'wss://rtc.example.test/a..b/..c/d../...' },
  { ...connect, token: jwt(ROOM_AUDIO_MAX_TOKEN) },
  withControls({ bitrate: 8000 }),
  withControls({ bitrate: 64000 }),
  { ...connect, canSpeak: false, relayOnly: true, red: false },
  { ...connect, controls: { ...controls, userVolumes: users(ROOM_AUDIO_MAX_USERS) } },
  { ...connect, controls: { ...controls, watched: watched(ROOM_AUDIO_MAX_WATCHED) } },
  withControls({ watched: watched(1, 0) }),
  withControls({ watched: watched(1, 0.5) }),
  withControls({ muted: true, deafened: true, volume: 0, levels: true }),
  withControls({ userVolumes: users(ROOM_AUDIO_MAX_USERS, 0.25), watched: watched(ROOM_AUDIO_MAX_WATCHED) }),
  withGate({ mode: 'ptt', pttOpen: true }),
  withGate({ mode: 'open', thresholdDb: 0 }),
  withGate({ thresholdDb: -80 }),
  withGate({ thresholdDb: -32.5 }),
  { ...cue, volume: 0 },
  { ...cue, volume: 0.25 },
  { ...disconnect, connectionId: connectionId.toUpperCase() },
];

export const REJECTED: Fixture[] = [
  // Operations and unknown fields.
  {},
  { operation: 'nativeLogin' },
  { operation: 'status', connectionId },
  { operation: 1, connectionId },
  { ...disconnect, roomId },
  { ...disconnect, volume: 1 },
  { ...control, cue: 'join' },
  { ...connect, cookie: 'forbidden' },
  { ...connect, extra: null },
  // Identifiers.
  { ...disconnect, connectionId: 'bad' },
  { ...disconnect, connectionId: '00000000-0000-0000-0000-000000000000' },
  { ...disconnect, connectionId: `${connectionId}\n` },
  { ...disconnect, connectionId: 7 },
  { ...disconnect, connectionId: undefined },
  { ...connect, roomId: 'bad' },
  { ...connect, roomId: null },
  // URL.
  { ...connect, url: `${url(ROOM_AUDIO_MAX_URL)}p` },
  { ...connect, url: 'ws://rtc.example.test' },
  { ...connect, url: 'https://rtc.example.test' },
  { ...connect, url: 'WSS://rtc.example.test' },
  { ...connect, url: 'wss://' },
  { ...connect, url: 'wss://user:pass@rtc.example.test' },
  { ...connect, url: 'wss://user@rtc.example.test' },
  { ...connect, url: 'wss://rtc.example.test/#fragment' },
  { ...connect, url: 'wss://rtc.example.test/?access_token=x' },
  { ...connect, url: 'wss://a..b' },
  { ...connect, url: 'wss://.example.test' },
  { ...connect, url: 'wss://example.test.' },
  { ...connect, url: 'wss://-a.example.test' },
  { ...connect, url: 'wss://a-.example.test' },
  { ...connect, url: 'wss://rtc.example.test/a%20b' },
  { ...connect, url: 'wss://rtc.example.test/%2e%2e/secret' },
  { ...connect, url: 'wss://rtc.example.test/.' },
  { ...connect, url: 'wss://rtc.example.test/..' },
  { ...connect, url: 'wss://rtc.example.test/./a' },
  { ...connect, url: 'wss://rtc.example.test/../a' },
  { ...connect, url: 'wss://rtc.example.test/a/../b' },
  { ...connect, url: 'wss://rtc.example.test/a/..' },
  { ...connect, url: 'wss://rtc.example.test:0' },
  { ...connect, url: 'wss://rtc.example.test:65536' },
  { ...connect, url: 'wss://rtc.example.test\n' },
  { ...connect, url: 'wss://rtc.example.test/a b' },
  { ...connect, url: 'wss://rtc.example.test\\path' },
  { ...connect, url: 'wss://рткс.example.test' },
  { ...connect, url: 1 },
  // JWT.
  { ...connect, token: jwt(ROOM_AUDIO_MAX_TOKEN + 1) },
  { ...connect, token: 'x'.repeat(100) },
  { ...connect, token: 'a..b' },
  { ...connect, token: 'a.b.c.d' },
  { ...connect, token: 'a.b.c\n' },
  { ...connect, token: 'a.b.c=' },
  { ...connect, token: null },
  // Numbers and booleans do not coerce.
  { ...connect, bitrate: 32000 },
  withControls({ bitrate: 7999 }),
  withControls({ bitrate: 64001 }),
  withControls({ bitrate: 32000.5 }),
  withControls({ bitrate: '32000' }),
  withControls({ bitrate: true }),
  withControls({ bitrate: null }),
  { ...connect, relayOnly: 'true' },
  { ...connect, red: 1 },
  { ...connect, canSpeak: 0 },
  // Controls.
  withControls({ muted: 'false' }),
  withControls({ deafened: 1 }),
  withControls({ levels: 0 }),
  withControls({ volume: -0.1 }),
  withControls({ volume: 1.1 }),
  withControls({ volume: '1' }),
  withControls({ volume: null }),
  withControls({ userVolumes: users(ROOM_AUDIO_MAX_USERS + 1) }),
  withControls({ userVolumes: { invalid: 1 } }),
  withControls({ userVolumes: { [user(0)]: 1.5 } }),
  withControls({ userVolumes: { [user(0)]: '1' } }),
  withControls({ userVolumes: [] }),
  withControls({ watched: watched(ROOM_AUDIO_MAX_WATCHED + 1) }),
  withControls({ watched: { invalid: 1 } }),
  withControls({ watched: { [user(0)]: 1.5 } }),
  withControls({ watched: { [user(0)]: -0.5 } }),
  withControls({ watched: { [user(0)]: '1' } }),
  withControls({ watched: [] }),
  withControls({ watched: [user(0)] }),
  withControls({ watched: null }),
  withControls({ extra: true }),
  { ...control, controls: { muted: false } },
  { ...control, controls: [] },
  { ...control, controls: null },
  { ...connect, controls: { ...controls, volume: 2 } },
  // Gate.
  withGate({ mode: 'always' }),
  withGate({ mode: 1 }),
  withGate({ thresholdDb: -80.5 }),
  withGate({ thresholdDb: 0.5 }),
  withGate({ thresholdDb: '-50' }),
  withGate({ pttOpen: 1 }),
  withGate({ extra: 1 }),
  withControls({ gate: null }),
  // Cues.
  { ...cue, cue: 'custom' },
  { ...cue, cue: 'builtin:' },
  { ...cue, cue: 'callIncoming' },
  { ...cue, cue: 'JOIN' },
  { ...cue, cue: 1 },
  { operation: 'cue', connectionId, cue: 'join' },
  { ...cue, volume: 1.5 },
  { ...cue, volume: -0.5 },
  { ...cue, volume: '1' },
  { ...cue, volume: null },
  // Far over any size: the message bound in TS, the ceiling in Swift.
  { ...connect, token: jwt(20000) },
];

export const OVER_MESSAGE_BOUND: Fixture[] = [
  { ...connect, url: url(ROOM_AUDIO_MAX_URL), token: jwt(ROOM_AUDIO_MAX_TOKEN),
    controls: { ...controls, userVolumes: users(ROOM_AUDIO_MAX_USERS, 0.123456789), watched: watched(ROOM_AUDIO_MAX_WATCHED, 0.123456789) } },
];

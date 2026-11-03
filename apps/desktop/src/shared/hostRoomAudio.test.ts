import { describe, expect, it } from 'vitest';
import { HOST_ACTIVITY_MAX_LENGTH, parseHostActivityMessage } from './hostActivity';
import { ROOM_AUDIO_MAX_TOKEN, ROOM_AUDIO_MAX_USERS, ROOM_AUDIO_MAX_WATCHED, parseRoomAudioControls, parseRoomAudioOperation, parseRoomAudioState, parseRoomAudioStatus } from './hostRoomAudio';
import { ACCEPTED, OVER_MESSAGE_BOUND, REJECTED, connect, connectionId, controls, control, disconnect, jwt, roomId, url, users, watched } from './hostRoomAudio.fixtures';

const document = '11111111-1111-4111-8111-111111111111';
const envelope = (operation: object, change: object = {}) => JSON.stringify({ v: 1, type: 'roomAudio', host: 0, document, seq: 1, request: 1, ...operation, ...change });
const parse = (operation: object) => parseHostActivityMessage(envelope(operation));

const state = {
  connectionId, phase: 'connected', microphoneReady: true, muted: false, canSpeak: true, speaking: false,
  speakers: [roomId], route: 'speaker', phoneCall: false,
};
const user = (i: number) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`;

describe('room audio operations', () => {
  it.each(ACCEPTED)('accepts the fixture %j', fixture => {
    expect(parseRoomAudioOperation(fixture)).not.toBeNull();
    expect(parse(fixture)).not.toBeNull();
  });
  it.each(REJECTED)('rejects the fixture %j', fixture => {
    expect(parse(fixture)).toBeNull();
  });
  it.each(OVER_MESSAGE_BOUND)('rejects the fixture %j only for the size of the whole message', fixture => {
    expect(parseRoomAudioOperation(fixture)).not.toBeNull();
    expect(parse(fixture)).toBeNull();
  });
  it('holds the whole message to 8192 bytes with every field inside its own bound', () => {
    const full = (urlLength: number) => envelope({ ...connect, url: url(urlLength), token: jwt(ROOM_AUDIO_MAX_TOKEN),
      controls: { ...controls, userVolumes: users(ROOM_AUDIO_MAX_USERS), watched: watched(ROOM_AUDIO_MAX_WATCHED) } });
    const urlLength = HOST_ACTIVITY_MAX_LENGTH - full(100).length + 100;
    expect(full(urlLength).length).toBe(HOST_ACTIVITY_MAX_LENGTH);
    expect(parseHostActivityMessage(full(urlLength))).not.toBeNull();
    expect(parseHostActivityMessage(full(urlLength + 1))).toBeNull();
  });
  it('requires the envelope: document, sequence, request and no unknown fields', () => {
    expect(parseHostActivityMessage(envelope(disconnect))).toMatchObject({ type: 'roomAudio', operation: 'disconnect', connectionId });
    for (const change of [{ document: 'bad' }, { seq: 0 }, { seq: 1.5 }, { seq: undefined }, { request: 0 }, { request: -1 }, { request: undefined }, { v: 2 }, { host: -1 }, { extra: true }]) {
      expect(parseHostActivityMessage(envelope(disconnect, change))).toBeNull();
    }
  });
  it('parses complete controls only', () => {
    expect(parseRoomAudioControls(controls)).toEqual(controls);
    expect(parseRoomAudioControls({ ...control.controls, gate: undefined })).toBeNull();
  });
});

describe('room audio state', () => {
  it('accepts every phase, origin, route and error of the snapshot', () => {
    for (const phase of ['connecting', 'connected', 'reconnecting', 'lost', 'interrupted', 'ended', 'failed']) expect(parseRoomAudioState({ ...state, phase })).not.toBeNull();
    for (const muteOrigin of ['web', 'system', 'server', 'native']) expect(parseRoomAudioState({ ...state, muted: true, muteOrigin })).not.toBeNull();
    for (const route of ['speaker', 'receiver', 'wired', 'bluetooth', 'other']) expect(parseRoomAudioState({ ...state, route })).not.toBeNull();
    for (const error of ['permission', 'connection', 'audio', 'superseded', 'removed', 'duplicate', 'closed', 'network']) expect(parseRoomAudioState({ ...state, error })).not.toBeNull();
    for (const level of [0, 20]) expect(parseRoomAudioState({ ...state, level })).not.toBeNull();
    const speakers = Array.from({ length: 64 }, (_, i) => user(i));
    expect(parseRoomAudioState({ ...state, speakers })).not.toBeNull();
  });
  it('rejects anything that could carry a credential or a device name, and broken values', () => {
    for (const change of [{ token: connect.token }, { url: connect.url }, { deviceName: 'AirPods' }, { connectionId: 'bad' }, { phase: 'unknown' },
      { microphoneReady: 1 }, { muted: 'no' }, { muteOrigin: 'web' }, { muted: true }, { muted: true, muteOrigin: 'user' }, { canSpeak: 0 }, { speaking: null },
      { speakers: ['bad'] }, { speakers: {} }, { speakers: Array.from({ length: 65 }, (_, i) => user(i)) }, { route: 'AirPods Pro' }, { phoneCall: 'false' },
      { error: 'unknown' }, { error: 1 }, { level: 21 }, { level: -1 }, { level: 1.5 }, { level: '1' }]) {
      expect(parseRoomAudioState({ ...state, ...change })).toBeNull();
    }
    for (const field of ['connectionId', 'phase', 'microphoneReady', 'muted', 'canSpeak', 'speaking', 'speakers', 'route', 'phoneCall'] as const) {
      const { [field]: _, ...partial } = state;
      expect(parseRoomAudioState(partial)).toBeNull();
    }
  });
  it('reports unsupported bare, and a snapshot or a failure only when supported', () => {
    expect(parseRoomAudioStatus({ supported: false })).toEqual({ supported: false });
    expect(parseRoomAudioStatus({ supported: true })).toEqual({ supported: true });
    expect(parseRoomAudioStatus({ supported: true, media: state })).toEqual({ supported: true, media: state });
    expect(parseRoomAudioStatus({ supported: true, failed: true })).toEqual({ supported: true, failed: true });
    expect(parseRoomAudioStatus({ supported: true, media: state, failed: true })).toEqual({ supported: true, media: state, failed: true });
    for (const value of [null, [], {}, { supported: 'true' }, { supported: false, media: state }, { supported: false, failed: true }, { supported: true, failed: false }, { supported: true, failed: 1 }, { supported: true, media: {} }, { supported: true, extra: 1 }, { supported: true, media: { ...state, token: connect.token } }]) {
      expect(parseRoomAudioStatus(value)).toBeNull();
    }
  });
});

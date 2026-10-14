import { RoomType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { useUi } from '../stores/ui';
import { setVoice, useVoice } from '../stores/voice';
import { isVoicePreview, joinButton, joinOutcome } from './voiceEntry';

const base = { inRoom: false, canConnect: true, owner: false, people: 0, limit: 0 };

describe('joinOutcome', () => {
  it('joins a room with space', () => {
    expect(joinOutcome(base)).toBe('join');
    expect(joinOutcome({ ...base, people: 3, limit: 4 })).toBe('join');
  });
  it('does nothing when already in it or without CONNECT', () => {
    expect(joinOutcome({ ...base, inRoom: true, people: 4, limit: 4 })).toBe('none');
    expect(joinOutcome({ ...base, canConnect: false })).toBe('none');
  });
  it('a full room says so, unless I am the workspace owner (admins and moderators are bound too, 07.10)', () => {
    expect(joinOutcome({ ...base, people: 4, limit: 4 })).toBe('full');
    expect(joinOutcome({ ...base, people: 4, limit: 4, owner: true })).toBe('join');
  });
});

describe('voice room chat without voice (docs/09 #14)', () => {
  const voiceRoom = { id: 'v2', type: RoomType.VOICE };
  it('is a preview when I am not in that room’s voice', () => {
    expect(isVoicePreview(voiceRoom, null)).toBe(true);
    expect(isVoicePreview(voiceRoom, 'v1')).toBe(true);
    expect(isVoicePreview(voiceRoom, 'v2')).toBe(false);
    expect(isVoicePreview({ id: 't', type: RoomType.TEXT }, null)).toBe(false);
    expect(isVoicePreview(undefined, null)).toBe(false);
  });

  it('opening the chat keeps the call in another room', () => {
    setVoice({ roomId: 'v1', workspaceId: 'w' });
    useUi.getState().openRoom('w', 'v2');
    expect(useUi.getState().lastRoom['w']).toBe('v2');
    expect(useVoice.getState().roomId).toBe('v1');
    expect(isVoicePreview(voiceRoom, useVoice.getState().roomId)).toBe(true);
  });
});

describe('row «Войти» visibility', () => {
  const base = { inRoom: false, canConnect: true, owner: false, people: 2, limit: 4, touch: false };
  it('is hover-only on desktop even with people, always on touch', () => {
    expect(joinButton(base)).toEqual({ shown: true, always: false });
    expect(joinButton({ ...base, touch: true })).toEqual({ shown: true, always: true });
  });
  it('is hidden in a full room, unless I am the workspace owner', () => {
    expect(joinButton({ ...base, people: 4 }).shown).toBe(false);
    expect(joinButton({ ...base, people: 4, owner: true }).shown).toBe(true);
    expect(joinButton({ ...base, people: 9, limit: 0 }).shown).toBe(true);
  });
  it('is hidden when already in the room or without CONNECT', () => {
    expect(joinButton({ ...base, inRoom: true }).shown).toBe(false);
    expect(joinButton({ ...base, canConnect: false }).shown).toBe(false);
  });
});

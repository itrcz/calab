import { describe, expect, it } from 'vitest';
import { keyAction, rowActions } from './quickSwitcherActions';

const none = { shiftKey: false, metaKey: false, ctrlKey: false };
const voice = { kind: 'room', voice: true, canConnect: true } as const;

describe('rowActions', () => {
  it('a voice room: join first, then its chat', () => {
    expect(rowActions(voice)).toEqual(['join', 'chat']);
  });
  it('a voice room without CONNECT and a text room only open the chat', () => {
    expect(rowActions({ ...voice, canConnect: false })).toEqual(['chat']);
    expect(rowActions({ kind: 'room' })).toEqual(['chat']);
  });
  it('a DM: «Написать»', () => {
    expect(rowActions({ kind: 'dm' })).toEqual(['write']);
  });
  it('a member: the author filter, then «Написать» when a DM is allowed', () => {
    expect(rowActions({ kind: 'member', canDm: true })).toEqual(['filter', 'write']);
    expect(rowActions({ kind: 'member' })).toEqual(['filter']);
  });
  it('a message: one «Открыть»', () => {
    expect(rowActions({ kind: 'message' })).toEqual(['open']);
  });
});

describe('keyAction', () => {
  it('Enter joins a voice room, ⇧Enter opens its chat (⌘Enter is «Все результаты»)', () => {
    expect(keyAction(voice, none)).toBe('join');
    expect(keyAction(voice, { ...none, shiftKey: true })).toBe('chat');
    expect(keyAction(voice, { ...none, metaKey: true })).toBe('join');
  });
  it('a member: Enter filters, ⇧Enter writes', () => {
    expect(keyAction({ kind: 'member', canDm: true }, none)).toBe('filter');
    expect(keyAction({ kind: 'member', canDm: true }, { ...none, shiftKey: true })).toBe('write');
  });
  it('rows with one action ignore the modifier', () => {
    expect(keyAction({ kind: 'room' }, none)).toBe('chat');
    expect(keyAction({ kind: 'room' }, { ...none, shiftKey: true })).toBe('chat');
    expect(keyAction({ kind: 'dm' }, { ...none, metaKey: true })).toBe('write');
    expect(keyAction({ kind: 'member' }, { ...none, shiftKey: true })).toBe('filter');
    expect(keyAction({ kind: 'message' }, { ...none, shiftKey: true })).toBe('open');
    expect(keyAction({ ...voice, canConnect: false }, { ...none, shiftKey: true })).toBe('chat');
  });
});

describe('call action (ADR-0034)', () => {
  it('a person I may call gets it after the write action, as a button only', () => {
    expect(rowActions({ kind: 'member', canDm: true, canCall: true })).toEqual(['filter', 'write', 'call']);
    expect(rowActions({ kind: 'dm', canCall: true })).toEqual(['write', 'call']);
    expect(rowActions({ kind: 'member', canDm: false, canCall: true })).toEqual(['filter']);
    expect(keyAction({ kind: 'dm', canCall: true }, { ...none, shiftKey: true })).toBe('write');
    expect(keyAction({ kind: 'member', canDm: true, canCall: true }, { ...none, shiftKey: true })).toBe('write');
  });
});

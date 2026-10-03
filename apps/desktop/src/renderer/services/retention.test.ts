import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@calaba/protocol';
import { trimWindow, type ChatMessage, type RoomMessages } from '../stores/messages';

vi.mock('../stores/ui', () => ({ useUi: { getState: () => ({}), subscribe: () => () => undefined } }));
const { IDLE_MS, retentionAction } = await import('./retention');

const msg = (id: string): Message => ({ id, roomId: 'r', nonce: '' }) as unknown as Message;
const sentItem = (id: string): ChatMessage => ({ key: id, msg: msg(id), status: 'sent' });
const win = (n: number, extra: Partial<RoomMessages> = {}): RoomMessages => ({
  items: Array.from({ length: n }, (_, i) => sentItem(`m${String(i).padStart(4, '0')}`)),
  hasMoreBefore: false,
  hasMoreAfter: false,
  loading: false,
  loaded: true,
  error: null,
  base: 0,
  ...extra,
});

describe('message retention (review M10)', () => {
  it('trims a background window to the newest N and marks older history as loadable', () => {
    const r = win(250);
    const t = trimWindow(r, 200);
    expect(t?.items).toHaveLength(200);
    expect(t?.items[0]?.key).toBe('m0050');
    expect(t?.hasMoreBefore).toBe(true);
  });
  it('keeps pending messages and leaves small windows alone', () => {
    const pending: ChatMessage = { key: 'local:1', msg: msg(''), status: 'failed' };
    const r = { ...win(210), items: [...win(210).items, pending] };
    expect(trimWindow(r, 200)?.items.at(-1)).toBe(pending);
    const small = win(10);
    expect(trimWindow(small, 200)).toBe(small);
  });
  it('drops a window that browses old history', () => {
    expect(trimWindow(win(10, { hasMoreAfter: true }), 200)).toBeNull();
  });
  it('never drops pending / failed messages in a history window (review N2)', () => {
    for (const status of ['pending', 'failed'] as const) {
      const unsent: ChatMessage = { key: 'local:1', msg: msg(''), status };
      const r = win(10, { hasMoreAfter: true });
      const withUnsent = { ...r, items: [...r.items, unsent] };
      const t = trimWindow(withUnsent, 200);
      expect(t).not.toBeNull();
      expect(t?.items).toContain(unsent);
    }
  });
  it('decides per room: open → keep; idle → unload unless something is unsent', () => {
    expect(retentionAction({ open: true, hasPending: false, idleMs: IDLE_MS * 10 })).toBe('keep');
    expect(retentionAction({ open: false, hasPending: false, idleMs: 1000 })).toBe('trim');
    expect(retentionAction({ open: false, hasPending: false, idleMs: IDLE_MS })).toBe('unload');
    expect(retentionAction({ open: false, hasPending: true, idleMs: IDLE_MS })).toBe('trim');
  });
});

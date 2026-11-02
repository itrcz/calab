import type { Participant, Room } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop app whose overlay cannot open (no display for the source, Linux…): issue #102.
const open = vi.fn(() => Promise.resolve(false));
const send = vi.fn();
vi.mock('../platform', () => ({ isWeb: false, platform: { kind: 'electron', annotOverlay: { open, send, close: vi.fn() } } }));

const { annot, viewFor, ACTIVITY_MS } = await import('./annot');
const { encodeAnnot } = await import('../lib/annot/codec');
const { useAnnot, setAnnot } = await import('../stores/annot');

const ME = 'me:s1';
const SID = 'TR_mine';
const room = { localParticipant: { identity: ME, publishData: vi.fn(() => Promise.resolve()) }, remoteParticipants: new Map() } as unknown as Room;
const viewer = { identity: 'boris:s2', permissions: { canPublish: true, canPublishSources: [] } } as unknown as Participant;
let seq = 0;

function point(kind: 'pointer' | 'stroke' = 'pointer'): void {
  const bytes = encodeAnnot({ streamSid: SID, kind, color: 0xff0000, points: [0.5, 0.5], seq: ++seq, strokeId: kind === 'stroke' ? 1 : 0, strokeEnd: false, allow: false });
  if (!bytes) throw new Error('encode');
  annot.onData(bytes, viewer);
}

describe('where the presenter sees annotations', () => {
  it('over the screen only for a whole screen in the desktop app', () => {
    expect(viewFor({ sourceId: 'screen:1:0', displayId: '' }, false)).toBe('screen');
    expect(viewFor(null, false)).toBe('preview');
    expect(viewFor({ sourceId: 'screen:1:0', displayId: '1' }, true)).toBe('preview');
  });
});

describe('presenter fallback (issue #102)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    setAnnot({ allowMine: true, mineActivity: null, mineView: 'preview' });
    annot.attach(room);
    annot.presenting(SID, { sourceId: 'screen:0:0', displayId: '' });
  });
  afterEach(() => {
    annot.detach();
    vi.useRealTimers();
    open.mockClear();
  });

  it('says who annotates and falls back to the preview when the overlay cannot open', async () => {
    expect(useAnnot.getState().mineView).toBe('screen');
    point();
    expect(useAnnot.getState().mineActivity).toEqual({ name: expect.any(String) as string, kind: 'pointer' });
    expect(open).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(useAnnot.getState().mineView).toBe('preview'));
    // Later annotations do not retry the overlay.
    point('stroke');
    expect(open).toHaveBeenCalledOnce();
    expect(useAnnot.getState().mineActivity?.kind).toBe('stroke');
  });

  it('the indicator goes after a quiet spell, with no timer left behind', () => {
    point();
    vi.advanceTimersByTime(ACTIVITY_MS - 1000);
    point();
    vi.advanceTimersByTime(ACTIVITY_MS - 500);
    expect(useAnnot.getState().mineActivity).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(useAnnot.getState().mineActivity).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('follows my stream republished under a new sid after a full reconnect', () => {
    annot.republished('TR_new');
    // The old sid is no longer mine: dropped like any stream that is not live.
    point();
    expect(useAnnot.getState().mineActivity).toBeNull();
    const bytes = encodeAnnot({ streamSid: 'TR_new', kind: 'pointer', color: 0xff0000, points: [0.5, 0.5], seq: ++seq, strokeId: 0, strokeEnd: false, allow: false });
    if (!bytes) throw new Error('encode');
    annot.onData(bytes, viewer);
    expect(useAnnot.getState().mineActivity?.kind).toBe('pointer');
    expect(open).toHaveBeenCalledWith({ sourceId: 'screen:0:0', displayId: '' });
  });

  it('the presenter forbidding annotations clears the indicator', () => {
    point();
    annot.setAllowMine(false);
    expect(useAnnot.getState().mineActivity).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

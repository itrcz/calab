import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Ivs = { agoStartMs: number; agoEndMs: number }[];
const sent: { roomId: string; recordingId: string; ivs: Ivs }[] = [];
const gw = { up: true };
const leaveHooks: (() => void)[] = [];

vi.mock('./gateway', () => ({
  sendRecordingSpeech: (roomId: string, recordingId: string, build: () => Ivs) => {
    if (!gw.up) return false;
    sent.push({ roomId, recordingId, ivs: build() });
    return true;
  },
}));
vi.mock('./voice', () => ({ voice: { onBeforeLeave: (fn: () => void) => leaveHooks.push(fn) } }));

const { useVoice } = await import('../stores/voice');
const { useRecordings } = await import('../stores/recordings');
const { startSpeechReports, resetSpeechReportsForTest, FLUSH_MS, PENDING_MS } = await import('./recordingSpeech');

function record(roomId: string | null, recordingId = 'rec1'): void {
  useRecordings.setState({ byRoom: roomId ? ({ [roomId]: { recordingId } } as never) : {} });
}

describe('on-air reports service (ADR-0169)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    gw.up = true;
    leaveHooks.length = 0;
    resetSpeechReportsForTest();
    record(null);
    useVoice.setState({ roomId: 'r1', transmitting: false });
  });
  afterEach(() => {
    resetSpeechReportsForTest();
    vi.useRealTimers();
  });

  it('runs no timer while nothing is recorded', () => {
    startSpeechReports();
    useVoice.setState({ transmitting: true });
    expect(vi.getTimerCount()).toBe(0);
    record('r1');
    expect(vi.getTimerCount()).toBe(1);
    record(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports every 10 s and flushes the last stretch on the stop', () => {
    startSpeechReports();
    record('r1');
    useVoice.setState({ transmitting: true });
    vi.advanceTimersByTime(2000);
    useVoice.setState({ transmitting: false });
    vi.advanceTimersByTime(FLUSH_MS - 2000);
    expect(sent).toHaveLength(1);
    useVoice.setState({ transmitting: true });
    vi.advanceTimersByTime(1000);
    record(null); // the stop
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ roomId: 'r1', recordingId: 'rec1' });
    expect(sent[1]?.ivs).toHaveLength(1);
  });

  it('flushes before the connection goes on a leave and on a move', () => {
    startSpeechReports();
    record('r1');
    useVoice.setState({ transmitting: true });
    vi.advanceTimersByTime(1500);
    for (const fn of leaveHooks) fn(); // voice.leave(): before teardown
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ivs).toEqual([{ agoStartMs: 1500, agoEndMs: 0 }]);
    useVoice.setState({ transmitting: false, roomId: null }); // the teardown follows
    expect(sent).toHaveLength(1);

    useVoice.setState({ roomId: 'r1', transmitting: true });
    vi.advanceTimersByTime(500);
    record('r2', 'rec2');
    useVoice.setState({ roomId: 'r2' }); // moved by a moderator: same connection, new room
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ roomId: 'r1', recordingId: 'rec1' });
  });

  it('keeps a final report that could not go and retries it within the grace, then drops it', () => {
    startSpeechReports();
    record('r1');
    useVoice.setState({ transmitting: true });
    vi.advanceTimersByTime(1000);
    gw.up = false;
    useVoice.setState({ transmitting: false });
    record(null);
    expect(sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1); // the pending log keeps the timer
    gw.up = true;
    vi.advanceTimersByTime(FLUSH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ roomId: 'r1', recordingId: 'rec1' });
    expect(vi.getTimerCount()).toBe(0);

    // Never back in time: dropped after the grace.
    record('r1');
    useVoice.setState({ transmitting: true });
    vi.advanceTimersByTime(1000);
    gw.up = false;
    record(null);
    vi.advanceTimersByTime(PENDING_MS + FLUSH_MS);
    expect(vi.getTimerCount()).toBe(0);
    gw.up = true;
    vi.advanceTimersByTime(FLUSH_MS);
    expect(sent).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_REPORT, SpeechLog } from './recordingSpeech';

describe('SpeechLog (ADR-0169 on-air reports)', () => {
  it('reports closed and open intervals as ms ago, and continues the open one after a commit', () => {
    const log = new SpeechLog();
    expect(log.empty).toBe(true);
    log.on(1000);
    log.off(3000);
    log.on(5000);
    const r = log.peek(8000);
    expect(r).toEqual([
      { agoStartMs: 7000, agoEndMs: 5000 },
      { agoStartMs: 3000, agoEndMs: 0 },
    ]);
    log.commit(8000, r.length);
    log.off(9000);
    expect(log.peek(10000)).toEqual([{ agoStartMs: 2000, agoEndMs: 1000 }]);
  });

  it('keeps everything when a report could not be sent', () => {
    const log = new SpeechLog();
    log.on(0);
    log.off(500);
    log.peek(1000);
    expect(log.peek(2000)).toEqual([{ agoStartMs: 2000, agoEndMs: 1500 }]);
  });

  it('ignores repeated edges and empty intervals', () => {
    const log = new SpeechLog();
    log.off(10);
    log.on(100);
    log.on(200);
    log.off(100);
    expect(log.empty).toBe(true);
    log.on(300);
    log.off(400);
    expect(log.peek(400)).toEqual([{ agoStartMs: 100, agoEndMs: 0 }]);
  });

  it('sends at most MAX_REPORT intervals per report, oldest first', () => {
    const log = new SpeechLog();
    for (let i = 0; i < MAX_REPORT + 5; i++) {
      log.on(i * 10);
      log.off(i * 10 + 5);
    }
    const first = log.peek(10_000);
    expect(first).toHaveLength(MAX_REPORT);
    log.commit(10_000, first.length);
    expect(log.peek(10_000)).toHaveLength(5);
  });
});

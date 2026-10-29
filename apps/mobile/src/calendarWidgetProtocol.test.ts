import { describe, expect, it } from 'vitest';
import { ActivityProtocol } from './activityProtocol';
const document = '00000000-0000-0000-0000-000000000001';
const base = { v: 1, type: 'calendarWidget', host: 0, document, seq: 1, request: 1 };
const configure = { ...base, operation: 'configure', token: 'header.payload.signature', expiresAt: '2026-11-20T00:00:00Z' };
describe('calendar widget native protocol', () => {
  it('requires current document/sequence and a bounded narrow operation', () => {
    const p = new ActivityProtocol(0);
    expect(p.accept(JSON.stringify(configure))).toBeNull();
    p.accept(JSON.stringify({ v: 1, type: 'hello', host: 0, document }));
    expect(p.accept(JSON.stringify(configure))).toMatchObject({ type: 'calendarWidget', operation: 'configure' });
    expect(p.accept(JSON.stringify(configure))).toBeNull();
    expect(p.accept(JSON.stringify({ ...configure, seq: 2, url: 'https://attacker.test' }))).toBeNull();
    expect(p.accept(JSON.stringify({ ...configure, seq: 2, token: 'x'.repeat(2049) }))).toBeNull();
    expect(p.accept(JSON.stringify({ ...configure, seq: 2, expiresAt: 'bad' }))).toBeNull();
    expect(p.accept(JSON.stringify({ ...base, seq: 2, operation: 'clear' }))).toMatchObject({ operation: 'clear' });
    p.reset();
    expect(p.accept(JSON.stringify({ ...base, seq: 3, operation: 'refresh' }))).toBeNull();
  });
});

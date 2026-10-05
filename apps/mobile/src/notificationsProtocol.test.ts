import { describe, expect, it } from 'vitest';
import { ActivityProtocol, activityReady } from './activityProtocol';
import { parseHostActivityMessage, parseNotificationState, parsePushReference } from '../../desktop/src/shared/hostActivity';
const document = '00000000-0000-0000-0000-000000000001';
const request = { v: 1, type: 'notifications', host: 0, document, seq: 1, request: 1, operation: 'request' };
describe('message notifications share the native-verified document boundary', () => {
 it('cannot request permission/token before hello, after revoke, from old documents or other hosts', () => {
  const p = new ActivityProtocol(0); expect(p.accept(JSON.stringify(request))).toBeNull();
  p.accept(JSON.stringify({ v: 1, type: 'hello', host: 0, document }));
  expect(p.accept(JSON.stringify({ ...request, host: 1 }))).toBeNull();
  expect(p.accept(JSON.stringify(request))).toMatchObject({ type: 'notifications', operation: 'request' });
  expect(p.accept(JSON.stringify(request))).toBeNull();
  p.accept(JSON.stringify({ v: 1, type: 'revoke', host: 0, document, seq: 2 }));
  expect(p.isCurrent(document)).toBe(false); expect(p.accept(JSON.stringify({ ...request, seq: 3 }))).toBeNull();
 });
 it('bounds operation schema and negotiates notifications even without activity permission', () => {
  for (const extra of [{ operation: 'url' }, { request: -1 }, { accessToken: 'secret' }, { v: 2 }]) expect(parseHostActivityMessage(JSON.stringify({ ...request, ...extra }))).toBeNull();
  expect(activityReady(0, document, false)).toContain('"capability":"notifications"');
 });
 it('only accepts bounded native tokens and opaque unexpired taps, never URLs/auth/product routes', () => {
  const valid = { binding: document, eventId: document, expiresAt: Date.now() + 60_000 };
  expect(parsePushReference(valid)).toEqual(valid);
  expect(parsePushReference({ ...valid, url: 'https://untrusted.invalid' })).toBeNull();
  expect(parsePushReference({ ...valid, expiresAt: 0 })).toBeNull();
  expect(parseNotificationState({ permission: 'granted', token: 'secret' })).toBeNull();
  expect(parseNotificationState({ permission: 'denied', token: 'aa'.repeat(32) })).toBeNull();
  expect(parseNotificationState({ permission: 'unsupported' })).toEqual({ permission: 'unsupported' });
 });
});

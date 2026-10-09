import { describe, expect, it } from 'vitest';
import { ActivityProtocol, activityReady, activityBootstrap } from './activityProtocol';
import { parseHostActivityMessage, parseNotificationState, parsePushReference } from '../../desktop/src/shared/hostActivity';
const document = '00000000-0000-0000-0000-000000000001';
const request = { v: 1, type: 'notifications', host: 0, document, seq: 1, request: 1, operation: 'request' };
describe('message notifications share the native-verified document boundary', () => {
 it('offers a bounded local test only in new binaries and the current document', () => {
  expect(activityBootstrap(0)).toContain('notificationsTestVersion: 1');
  const p = new ActivityProtocol(0);
  const test = { ...request, operation: 'test', body: 'Test notification' };
  expect(p.accept(JSON.stringify(test))).toBeNull();
  p.accept(JSON.stringify({ v: 1, type: 'hello', host: 0, document }));
  expect(p.accept(JSON.stringify(test))).toMatchObject({ operation: 'test', body: 'Test notification' });
  for (const extra of [{ body: '' }, { body: 'x'.repeat(513) }, { body: 1 }, { url: 'https://invalid.test' }, { token: 'secret' }]) {
   expect(parseHostActivityMessage(JSON.stringify({ ...test, ...extra }))).toBeNull();
  }
  p.accept(JSON.stringify({ v: 1, type: 'revoke', host: 0, document, seq: 2 }));
  expect(p.accept(JSON.stringify({ ...test, seq: 3 }))).toBeNull();
 });
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

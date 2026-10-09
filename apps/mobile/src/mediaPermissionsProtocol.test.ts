import { describe, expect, it } from 'vitest';
import { ActivityProtocol, activityBootstrap, activityReady } from './activityProtocol';
import { parseHostActivityMessage } from '../../desktop/src/shared/hostActivity';
import { parseMediaPermissionsState } from '../../desktop/src/shared/hostPermissions';

const document = '00000000-0000-0000-0000-000000000001';
const request = { v: 1, host: 0, document, type: 'permissions', seq: 1, request: 1, operation: 'request', kind: 'microphone' };
describe('native media permission boundary', () => {
  it('accepts only exact allowlisted operations and no URLs or arbitrary OS permission names', () => {
    for (const kind of ['microphone', 'camera']) expect(parseHostActivityMessage(JSON.stringify({ ...request, kind }))).toMatchObject({ kind });
    for (const extra of [{ kind: 'contacts' }, { kind: '' }, { kind: 'camera', url: 'app-settings:' }, { seq: 0 }, { request: -1 }, { operation: 'capture' }]) {
      expect(parseHostActivityMessage(JSON.stringify({ ...request, ...extra }))).toBeNull();
    }
    const { kind: _kind, ...base } = request;
    for (const operation of ['status', 'settings']) {
      expect(parseHostActivityMessage(JSON.stringify({ ...base, operation }))).toMatchObject({ operation });
      expect(parseHostActivityMessage(JSON.stringify({ ...base, operation, url: 'https://evil.test' }))).toBeNull();
    }
    expect(parseHostActivityMessage(JSON.stringify(base))).toBeNull();
  });
  it('requires the current document, host and increasing sequence, including after revoke', () => {
    const p = new ActivityProtocol(0);
    expect(p.accept(JSON.stringify(request))).toBeNull();
    p.accept(JSON.stringify({ v: 1, type: 'hello', host: 0, document }));
    expect(p.accept(JSON.stringify({ ...request, host: 1 }))).toBeNull();
    expect(p.accept(JSON.stringify(request))).toMatchObject({ type: 'permissions', kind: 'microphone' });
    expect(p.accept(JSON.stringify(request))).toBeNull();
    p.accept(JSON.stringify({ v: 1, type: 'revoke', host: 0, document, seq: 2 }));
    expect(p.accept(JSON.stringify({ ...request, seq: 3 }))).toBeNull();
    expect(activityBootstrap(0)).toContain('mediaPermissionsVersion: 1');
    expect(activityReady(0, document, false)).toContain('"permissions":1');
  });
  it('narrows native replies without inventing a grant from malformed or partial state', () => {
    for (const status of ['granted', 'denied', 'not-determined', 'restricted', 'n/a']) {
      expect(parseMediaPermissionsState({ microphone: status, camera: status })).toEqual({ microphone: status, camera: status });
    }
    for (const value of [null, {}, { microphone: 'granted' }, { microphone: 'yes', camera: 'granted' }, { microphone: 'granted', camera: 'denied', token: 'secret' }]) {
      expect(parseMediaPermissionsState(value)).toBeNull();
    }
  });
});

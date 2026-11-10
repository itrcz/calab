import { describe, expect, it } from 'vitest';
import { classifyMediaError, describeMediaError, mediaErrorDetail } from './errors';

const desk = { web: false };
const web = { web: true };
const dom = (name: string, message = ''): Error => Object.assign(new Error(message), { name });
const api = (code: string, status: number): Error => Object.assign(new Error('raw server text'), { name: 'ApiError', code, status });
const lk = (reasonName: string): Error => Object.assign(new Error('could not establish pc connection'), { name: 'ConnectionError', reasonName });

describe('classifyMediaError', () => {
  it('maps getUserMedia DOMExceptions', () => {
    expect(classifyMediaError(dom('NotAllowedError', 'Permission denied'), 'mic', desk)).toBe('permission');
    expect(classifyMediaError(dom('NotAllowedError', 'Permission denied by system'), 'mic', desk)).toBe('os-permission');
    expect(classifyMediaError(dom('NotFoundError'), 'mic', desk)).toBe('not-found');
    expect(classifyMediaError(dom('DevicesNotFoundError'), 'mic', desk)).toBe('not-found');
    expect(classifyMediaError(dom('NotReadableError', 'Could not start audio source'), 'mic', desk)).toBe('busy');
    expect(classifyMediaError(dom('OverconstrainedError'), 'mic', desk)).toBe('overconstrained');
    expect(classifyMediaError(dom('NotSupportedError', 'Not supported'), 'mic', web)).toBe('unsupported');
    expect(classifyMediaError(dom('SecurityError'), 'mic', web)).toBe('insecure');
  });

  it('tells a capture that never started from a busy device (issue #322)', () => {
    // Chromium: the device opened, no frame within the start timeout → AbortError, not «busy».
    expect(classifyMediaError(dom('AbortError', 'Timeout starting video source'), 'camera', desk)).toBe('stalled');
    expect(classifyMediaError(dom('AbortError', 'Timeout starting audio source'), 'mic', desk)).toBe('stalled');
    expect(classifyMediaError(dom('AbortError', 'Timeout starting video source'), 'camera', web)).toBe('stalled');
    expect(classifyMediaError(dom('NotReadableError', 'Could not start video source'), 'camera', desk)).toBe('busy');
    expect(classifyMediaError(dom('NotReadableError', 'Device in use'), 'camera', desk)).toBe('busy');
    expect(classifyMediaError(dom('AbortError', 'Starting videoinput failed'), 'camera', desk)).toBe('busy');
    expect(describeMediaError(dom('AbortError', 'Timeout starting video source'), 'camera', desk)).toMatchObject({
      code: 'stalled',
      text: 'Камера включилась, но не передаёт изображение',
      action: 'voice-settings',
    });
    expect(describeMediaError(dom('AbortError', 'Timeout starting audio source'), 'mic', desk).text).toBe('Микрофон занят другим приложением или не отвечает');
    expect(describeMediaError(dom('NotReadableError'), 'camera', desk).text).toBe('Камера занята другим приложением');
  });

  it('tells a closed browser picker from an OS denial', () => {
    expect(classifyMediaError(dom('NotAllowedError', 'Permission denied'), 'screen', web)).toBe('cancelled');
    expect(classifyMediaError(dom('NotAllowedError', 'Permission denied by system'), 'screen', web)).toBe('os-permission');
    expect(classifyMediaError(dom('NotAllowedError', 'Permission denied'), 'screen', desk)).toBe('os-permission');
    expect(classifyMediaError(dom('AbortError'), 'screen', web)).toBe('cancelled');
  });

  it('maps API errors', () => {
    expect(classifyMediaError(api('ERROR_CODE_ROOM_FULL', 409), 'voice', desk)).toBe('room-full');
    expect(classifyMediaError(api('ERROR_CODE_CONFLICT', 409), 'stream', desk)).toBe('stream-limit');
    expect(classifyMediaError(api('ERROR_CODE_FORBIDDEN', 403), 'stream', desk)).toBe('forbidden');
    expect(classifyMediaError(api('ERROR_CODE_UNAVAILABLE', 0), 'voice', desk)).toBe('network');
    expect(classifyMediaError(api('ERROR_CODE_UNAVAILABLE', 503), 'voice', desk)).toBe('server');
    expect(classifyMediaError(api('ERROR_CODE_INTERNAL', 500), 'voice', desk)).toBe('server');
    expect(classifyMediaError(api('ERROR_CODE_RATE_LIMITED', 429), 'voice', desk)).toBe('rate-limited');
  });

  it('maps LiveKit errors', () => {
    expect(classifyMediaError(lk('ServerUnreachable'), 'voice', desk)).toBe('network');
    expect(classifyMediaError(lk('WebSocket'), 'voice', desk)).toBe('network');
    expect(classifyMediaError(lk('NotAllowed'), 'voice', desk)).toBe('forbidden');
    expect(classifyMediaError(lk('Timeout'), 'voice', desk)).toBe('timeout');
    expect(classifyMediaError(dom('PublishTrackError', 'failed to publish'), 'stream', desk)).toBe('codec');
    expect(classifyMediaError(dom('NegotiationError'), 'stream', desk)).toBe('codec');
    expect(classifyMediaError(dom('DeviceUnsupportedError'), 'voice', web)).toBe('unsupported');
  });

  it('reads plain messages', () => {
    expect(classifyMediaError(new TypeError('Failed to fetch'), 'voice', desk)).toBe('network');
    expect(classifyMediaError(new Error('codec av1 not supported'), 'stream', desk)).toBe('codec');
    expect(classifyMediaError(new Error('Not supported'), 'stream', desk)).toBe('codec');
    expect(classifyMediaError(new Error('Not supported'), 'screen', web)).toBe('unsupported');
    expect(classifyMediaError(new TypeError("Cannot read properties of undefined (reading 'getUserMedia')"), 'mic', web)).toBe('unsupported');
    expect(classifyMediaError('boom', 'voice', desk)).toBe('unknown');
    expect(classifyMediaError(null, 'mic', desk)).toBe('unknown');
  });
});

describe('describeMediaError', () => {
  it('never returns the raw text', () => {
    const raws = [dom('NotAllowedError', 'Permission denied'), api('ERROR_CODE_INTERNAL', 500), lk('InternalError'), new Error('Not supported'), new Error('Error: xyz')];
    for (const ctx of ['mic', 'screen', 'stream', 'voice', 'streamAudio'] as const) {
      for (const e of raws) {
        for (const env of [desk, web]) {
          const h = describeMediaError(e, ctx, env);
          expect(h.text).not.toMatch(/Permission denied|raw server text|Not supported|Error:|xyz|pc connection/);
          expect(h.text.length).toBeGreaterThan(5);
          expect(h.text).not.toContain('!');
        }
      }
    }
  });

  it('offers the right action', () => {
    expect(describeMediaError(dom('NotAllowedError'), 'mic', desk)).toMatchObject({ text: 'Микрофон недоступен — проверьте разрешение', action: 'mic-privacy' });
    // Browsers have no OS settings deep link: the text says where to click instead.
    expect(describeMediaError(dom('NotAllowedError'), 'mic', web).action).toBeNull();
    expect(describeMediaError(dom('NotFoundError'), 'mic', desk).action).toBe('voice-settings');
    expect(describeMediaError(dom('NotAllowedError'), 'screen', desk).action).toBe('screen-privacy');
    expect(describeMediaError(lk('ServerUnreachable'), 'voice', desk).action).toBe('connection');
    expect(describeMediaError(api('ERROR_CODE_ROOM_FULL', 409), 'voice', desk)).toMatchObject({ text: 'Комната заполнена', action: null });
  });

  it('says «browser does not support» on the web', () => {
    expect(describeMediaError(dom('NotSupportedError'), 'mic', web).text).toBe('Ваш браузер не поддерживает доступ к микрофону');
    expect(describeMediaError(new Error('getDisplayMedia is not a function'), 'screen', web).text).toBe('Ваш браузер не поддерживает показ экрана');
  });

  it('is silent when the user closed the picker', () => {
    expect(describeMediaError(dom('NotAllowedError', 'Permission denied'), 'screen', web).silent).toBe(true);
    expect(describeMediaError(dom('NotAllowedError', 'Permission denied'), 'mic', web).silent).toBe(false);
  });

  it('accepts an explicit code (system audio)', () => {
    expect(describeMediaError(null, 'streamAudio', desk, 'no-loopback').text).toBe('Система не отдала звук — стрим идёт без звука');
    expect(describeMediaError(dom('NotReadableError'), 'streamAudio', desk).text).toBe('Звук системы недоступен — стрим идёт без звука');
  });
});

describe('mediaErrorDetail', () => {
  it('keeps the name, the message and the failed constraint for the log', () => {
    expect(mediaErrorDetail(dom('AbortError', 'Timeout starting video source'))).toEqual({ name: 'AbortError', message: 'Timeout starting video source' });
    expect(mediaErrorDetail(Object.assign(dom('OverconstrainedError', ''), { constraint: 'deviceId' }))).toEqual({ name: 'OverconstrainedError', message: '', constraint: 'deviceId' });
    expect(mediaErrorDetail('boom')).toEqual({ name: '', message: 'boom' });
    expect(mediaErrorDetail(null)).toEqual({ name: '', message: 'null' });
  });
});

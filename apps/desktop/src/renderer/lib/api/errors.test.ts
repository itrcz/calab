import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

const { ApiError } = await import('./client');
const { describeError, errorText, identityNotConfigured, isAbort, recentAuthRequired } = await import('./errors');

const api = (code: string, status: number, field?: string): InstanceType<typeof ApiError> => new ApiError(code, 'raw english message', status, field);

describe('describeError', () => {
  it('never returns the raw server message', () => {
    for (const code of ['ERROR_CODE_INTERNAL', 'ERROR_CODE_FORBIDDEN', 'ERROR_CODE_VALIDATION', 'ERROR_CODE_UNSPECIFIED', 'SOMETHING_NEW']) {
      expect(describeError(api(code, 400)).text).not.toContain('raw');
    }
  });

  it('maps codes to Russian texts', () => {
    expect(describeError(api('ERROR_CODE_FORBIDDEN', 403)).text).toBe('Недостаточно прав');
    expect(describeError(api('ERROR_CODE_ROOM_FULL', 409)).text).toBe('Комната заполнена');
    expect(describeError(api('ERROR_CODE_FILE_QUOTA_EXCEEDED', 413)).text).toMatch(/место/);
  });

  it('marks transient errors as retryable', () => {
    expect(describeError(api('ERROR_CODE_RATE_LIMITED', 429)).retry).toBe(true);
    expect(describeError(api('ERROR_CODE_INTERNAL', 500)).retry).toBe(true);
    expect(describeError(api('ERROR_CODE_FORBIDDEN', 403)).retry).toBe(false);
  });

  it('distinguishes network from a server outage', () => {
    expect(describeError(api('ERROR_CODE_UNAVAILABLE', 0)).text).toMatch(/Нет связи/);
    expect(describeError(api('ERROR_CODE_UNAVAILABLE', 503)).text).toMatch(/временно недоступен/);
    expect(describeError(new TypeError('Failed to fetch')).text).toMatch(/Нет связи/);
  });

  it('maps validation fields and keeps the field', () => {
    const h = describeError(api('ERROR_CODE_VALIDATION', 422, 'slug'));
    expect(h.field).toBe('slug');
    expect(h.text).toMatch(/^Адрес/);
    expect(describeError(api('ERROR_CODE_VALIDATION', 422, 'unknownField')).text).toBe('Проверьте введённые данные');
    expect(describeError(api('ERROR_CODE_VALIDATION', 422)).field).toBeUndefined();
  });

  it('maps a refused sticker of a batch (file[i] / emoji[i]) to its index and a clear reason', () => {
    const v = (field: string, message: string) => describeError(new ApiError('ERROR_CODE_VALIDATION', message, 422, field));
    expect(v('file[2]', 'not a valid WebP sticker: canvas 1024x1024 is larger than 512')).toEqual({
      text: 'Больше 512×512 — уменьшите картинку',
      field: 'file',
      index: 2,
      retry: false,
      generic: false,
    });
    expect(v('file[0]', 'not a valid WebP sticker: size 600x20 is outside 1..512').text).toMatch(/512×512/);
    expect(v('file[0]', 'not a valid WebP sticker: file is larger than 512 KB').text).toMatch(/^Слишком тяжёлый/);
    expect(v('file[0]', 'not a valid WebP sticker: more than 300 frames').text).toBe('Больше 300 кадров');
    expect(v('file[0]', 'not a valid WebP sticker: animation longer than 10000 ms').text).toBe('Анимация дольше 10 секунд');
    expect(v('file[0]', 'not a valid WebP sticker: missing RIFF/WEBP signature').text).toBe('Файл повреждён или это не WebP');
    expect(v('emoji[4]', 'must be one emoji')).toMatchObject({ text: 'Нужна одна эмодзи', field: 'emoji', index: 4 });
    // Not indexed: the plain field texts, no index.
    expect(v('file', 'no sticker files').index).toBeUndefined();
    // A replacement (PUT …/stickers/{sid}): plain `file`, no index.
    expect(v('file', 'not a valid WebP sticker: more than 300 frames')).toEqual({ text: 'Больше 300 кадров', field: 'file', retry: false, generic: false });
    expect(v('files[1]', 'x').text).toBe('Проверьте введённые данные');
  });

  it('falls back to the HTTP status for unknown codes', () => {
    expect(describeError(api('ERROR_CODE_UNSPECIFIED', 404)).text).toMatch(/Не найдено/);
    expect(describeError(api('ERROR_CODE_UNSPECIFIED', 502)).retry).toBe(true);
    expect(describeError(api('ERROR_CODE_UNSPECIFIED', 418)).generic).toBe(true);
  });

  it('hides arbitrary exceptions behind a generic text', () => {
    const h = describeError(new Error("Error invoking remote method 'files:download': boom"));
    expect(h.generic).toBe(true);
    expect(h.text).not.toMatch(/boom|invoking/);
    expect(describeError('string thrown').generic).toBe(true);
  });

  it('recognises aborts', () => {
    const e = new DOMException('aborted', 'AbortError');
    expect(isAbort(e)).toBe(true);
    expect(describeError(e).text).toBe('Отменено');
  });
});

describe('errorText', () => {
  it('prefixes the action', () => {
    expect(errorText(api('ERROR_CODE_FORBIDDEN', 403), 'Не удалось удалить')).toBe('Не удалось удалить. Недостаточно прав');
    expect(errorText(new Error('x'), 'Не удалось удалить')).toBe('Не удалось удалить. Попробуйте ещё раз');
    expect(errorText(api('ERROR_CODE_FORBIDDEN', 403))).toBe('Недостаточно прав');
  });
});

describe('identity states (2.0.1)', () => {
  const notConfigured = new ApiError('ERROR_CODE_CONFLICT', 'identity is not configured on this server', 409, undefined, { reason: 'IDENTITY_NOT_CONFIGURED' });
  it('a server without identity configuration is «не настроено», not a conflict or an outage', () => {
    expect(identityNotConfigured(notConfigured)).toBe(true);
    expect(identityNotConfigured(api('ERROR_CODE_CONFLICT', 409))).toBe(false);
    expect(identityNotConfigured(api('ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE', 503))).toBe(false);
    const h = describeError(notConfigured);
    expect(h.text).toMatch(/не настроены на этом сервере/);
    expect(h.retry).toBe(false);
  });
  it('RECENT_AUTH_REQUIRED asks to confirm the password, never shows the raw body', () => {
    const e = api('ERROR_CODE_RECENT_AUTH_REQUIRED', 403);
    expect(recentAuthRequired(e)).toBe(true);
    expect(recentAuthRequired(api('ERROR_CODE_FORBIDDEN', 403))).toBe(false);
    expect(describeError(e).text).toMatch(/^Подтвердите пароль/);
    expect(describeError(e).text).not.toContain('ERROR_CODE');
  });
});

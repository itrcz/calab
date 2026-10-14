import { describe, expect, it } from 'vitest';
import { downloadUrlData, isFileId, isImageContentType } from './imageDrag';

describe('isFileId', () => {
  it('accepts a UUID only', () => {
    expect(isFileId('0b6c1f7e-9a51-4d1b-8f3e-2a4d5c6b7e8f')).toBe(true);
    expect(isFileId('0B6C1F7E-9A51-4D1B-8F3E-2A4D5C6B7E8F')).toBe(true);
    expect(isFileId('../../api/me')).toBe(false);
    expect(isFileId('0b6c1f7e-9a51-4d1b-8f3e-2a4d5c6b7e8f/thumbnail')).toBe(false);
    expect(isFileId('0b6c1f7e-9a51-4d1b-8f3e-2a4d5c6b7e8f?x=1')).toBe(false);
    expect(isFileId('')).toBe(false);
    expect(isFileId(42)).toBe(false);
  });
});

describe('isImageContentType', () => {
  it('accepts image types, with parameters', () => {
    expect(isImageContentType('image/png')).toBe(true);
    expect(isImageContentType('IMAGE/JPEG; charset=binary')).toBe(true);
    expect(isImageContentType('image/svg+xml')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isImageContentType('application/octet-stream')).toBe(false);
    expect(isImageContentType('text/html')).toBe(false);
    expect(isImageContentType('image/')).toBe(false);
    expect(isImageContentType(null)).toBe(false);
  });
});

describe('downloadUrlData', () => {
  const blob = 'blob:https://app.calab.io/5f1e0c1a-1111-2222-3333-444455556666';
  it('formats mime:filename:url', () => {
    expect(downloadUrlData('image/png', 'cat.png', blob)).toBe(`image/png:cat.png:${blob}`);
    expect(downloadUrlData('image/jpeg', 'a.jpg', 'https://x.test/a.jpg')).toBe('image/jpeg:a.jpg:https://x.test/a.jpg');
  });
  it('keeps the separators unambiguous: no colon in the name, a plain MIME type', () => {
    expect(downloadUrlData('image/png', 'a:b.png', blob)).toBe(`image/png:a_b.png:${blob}`);
    expect(downloadUrlData('image/png:evil', 'a.png', blob)).toBe(`application/octet-stream:a.png:${blob}`);
    expect(downloadUrlData(undefined, 'a.png', blob)).toBe(`application/octet-stream:a.png:${blob}`);
  });
  it('sanitizes the name like a download', () => {
    expect(downloadUrlData('image/png', '../../x‮gnp.exe', blob)).toBe(`image/png:xgnp.exe:${blob}`);
    expect(downloadUrlData('image/png', '', blob)).toBe(`image/png:file:${blob}`);
  });
  it('refuses relative and non-web URLs', () => {
    expect(downloadUrlData('image/png', 'a.png', '/api/files/1')).toBeNull();
    expect(downloadUrlData('image/png', 'a.png', 'file:///etc/passwd')).toBeNull();
    expect(downloadUrlData('image/png', 'a.png', 'javascript:alert(1)')).toBeNull();
    expect(downloadUrlData('image/png', 'a.png', 'calaba-api://api/files/1')).toBeNull();
  });
});

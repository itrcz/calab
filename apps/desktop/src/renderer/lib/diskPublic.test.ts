import { describe, expect, it } from 'vitest';
import { folderParam, publicView, type PublicFile } from './diskPublic';

const file = (name: string, mime: string, extra: Partial<PublicFile> = {}): PublicFile => ({
  id: 'f', name, mime, size: 1000n, width: 0, height: 0, hasThumbnail: false, office: false, ...extra,
});

describe('publicView', () => {
  it('opens files like the app does', () => {
    expect(publicView(file('a.png', 'image/png', { hasThumbnail: true, width: 10, height: 10 }), false)).toBe('image');
    expect(publicView(file('a.mp4', 'video/mp4'), false)).toBe('video');
    expect(publicView(file('a.pdf', 'application/pdf'), false)).toBe('pdf');
    expect(publicView(file('a.mp3', 'audio/mpeg'), false)).toBe('audio');
    expect(publicView(file('a.md', 'text/markdown'), false)).toBe('text');
    expect(publicView(file('a.csv', 'text/csv'), false)).toBe('text');
    expect(publicView(file('a.zip', 'application/zip'), false)).toBe('card');
  });
  it('office files open in the viewer only when the server offers it', () => {
    const docx = file('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(publicView(docx, false)).toBe('card');
    expect(publicView({ ...docx, office: true }, false)).toBe('office');
  });
  it('the phone has no PDF viewer', () => {
    expect(publicView(file('a.pdf', 'application/pdf'), true)).toBe('card');
  });
});

describe('folderParam', () => {
  it('takes a uuid only', () => {
    expect(folderParam('?folder=01a13942-0de2-7841-8219-f2fcdcaa79df')).toBe('01a13942-0de2-7841-8219-f2fcdcaa79df');
    expect(folderParam('?folder=../x')).toBe('');
    expect(folderParam('')).toBe('');
  });
});

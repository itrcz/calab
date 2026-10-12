import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, protocol: {}, shell: {}, session: {} }));
vi.mock('../downloads', () => ({ markFromInternet: vi.fn(), uniquePath: vi.fn() }));
vi.mock('../logging', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

const { attachmentResponse, contentDisposition, isInlineMime, parseAttachmentUrl } = await import('./attachmentProtocol');
const { decideFrameNavigation, parseMailto } = await import('./frameGuard');
const { MailAccountsFile } = await import('./accounts');
const { mailAttachmentUrl } = await import('../../shared/mail');

const MID = 'a0123456789abcdef.12.3456.789';

describe('calaba-mail:// ids', () => {
  it('accepts exactly what mailAttachmentUrl builds', () => {
    expect(parseAttachmentUrl(mailAttachmentUrl(MID, '3'))).toEqual({ messageId: MID, attachmentId: '3' });
    expect(parseAttachmentUrl(`${mailAttachmentUrl(MID, '0')}?x=1`)).toEqual({ messageId: MID, attachmentId: '0' });
  });
  it('rejects anything else', () => {
    for (const u of [
      'calaba-mail://attachment/',
      `calaba-mail://attachment/${MID}`,
      `calaba-mail://attachment/${MID}/3/extra`,
      `calaba-mail://attachment/${MID}/../3`,
      `calaba-mail://attachment/${MID}/x`,
      `calaba-mail://attachment/${MID}/12345`,
      `calaba-mail://attachment/..%2F..%2Fetc/1`,
      'calaba-mail://attachment/a0123456789abcdeX.1.1.1/1',
      `calaba-mail://other/${MID}/1`,
      `calaba-api://attachment/${MID}/1`,
      `calaba-mail://attachment/${MID}/%E0%A4%A`,
    ]) {
      expect(parseAttachmentUrl(u), u).toBeNull();
    }
  });
  it('inline only for raster images; everything else is a download with a safe filename', async () => {
    expect(isInlineMime('image/png')).toBe(true);
    expect(isInlineMime('IMAGE/JPEG')).toBe(true);
    expect(isInlineMime('image/svg+xml')).toBe(false);
    expect(isInlineMime('text/html')).toBe(false);
    const img = attachmentResponse({ name: 'a.png', mime: 'image/png', data: new Uint8Array([1, 2]) });
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-disposition')).toBeNull();
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    const saved = attachmentResponse({ name: 'a.png', mime: 'image/png', data: new Uint8Array([1]) }, true);
    expect(saved.headers.get('content-disposition')).toMatch(/^attachment; filename="a\.png"/);
    const html = attachmentResponse({ name: 'evil".html\r\nX: y', mime: 'text/html', data: new Uint8Array([60]) });
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    expect(html.headers.get('content-disposition')).toMatch(/^attachment; filename="evil_\.html__X: y"; filename\*=UTF-8''/);
    expect(new Uint8Array(await html.arrayBuffer())).toEqual(new Uint8Array([60]));
    expect(contentDisposition('Отчёт.pdf')).toContain("filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf");
  });
});

describe('frame guard decisions', () => {
  const inMail = { isMainFrame: false, frameUrl: 'about:srcdoc', selfInitiated: true };
  it('a link clicked inside a mail body: http(s) → browser, mailto → compose, other schemes blocked', () => {
    expect(decideFrameNavigation({ ...inMail, url: 'https://example.org/x' })).toEqual({ action: 'external', url: 'https://example.org/x' });
    expect(decideFrameNavigation({ ...inMail, url: 'mailto:a@b.org?subject=Hi%20there&cc=c@d.org' })).toMatchObject({
      action: 'compose',
      event: { type: 'compose', to: [{ name: '', address: 'a@b.org' }], cc: [{ address: 'c@d.org' }], subject: 'Hi there' },
    });
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'calab://join/x', 'calaba-api://api/me', 'data:text/html,x', 'zoommtg://x']) {
      expect(decideFrameNavigation({ ...inMail, url })).toEqual({ action: 'block' });
    }
  });
  it('navigations not started by a mail body are only blocked, never opened', () => {
    expect(decideFrameNavigation({ ...inMail, url: 'https://example.org', selfInitiated: false })).toEqual({ action: 'block' });
    expect(decideFrameNavigation({ ...inMail, url: 'https://example.org', frameUrl: 'https://embed.example' })).toEqual({ action: 'block' });
  });
  it('main frame and srcdoc loads are left to the other guards', () => {
    expect(decideFrameNavigation({ ...inMail, url: 'https://example.org', isMainFrame: true })).toEqual({ action: 'ignore' });
    expect(decideFrameNavigation({ ...inMail, url: 'about:srcdoc', selfInitiated: false })).toEqual({ action: 'ignore' });
  });
  it('mailto parsing keeps plain addresses only', () => {
    expect(parseMailto('mailto:a@b.org,bad,%3Cx%3E@y?body=line1%0Aline2&BCC=z@q.org')).toEqual({
      type: 'compose',
      to: [{ name: '', address: 'a@b.org' }],
      cc: [],
      bcc: [{ name: '', address: 'z@q.org' }],
      subject: '',
      text: 'line1\nline2',
    });
    expect(parseMailto('https://x')).toBeNull();
  });
});

describe('accounts file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const box = (available = true) => ({
    available: () => available,
    encrypt: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decrypt: (b: Buffer) => Buffer.from(b.toString().slice(4), 'base64').toString(),
  });
  const acc = {
    id: 'a0123456789abcdef',
    email: 'me@x.org',
    name: '',
    provider: 'other' as const,
    imap: { host: 'imap.x.org', port: 993, security: 'tls' as const },
    smtp: { host: 'smtp.x.org', port: 465, security: 'tls' as const },
    login: 'me@x.org',
    password: 'secret-pass',
  };

  it('encrypts the whole list (no password in clear) and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calab-mail-acc-'));
    dirs.push(dir);
    const file = join(dir, 'mail', 'accounts.bin');
    const a = new MailAccountsFile(file, box(), vi.fn());
    a.put(acc);
    expect(readFileSync(file).toString()).not.toContain('secret-pass');
    const b = new MailAccountsFile(file, box(), vi.fn());
    expect(b.byEmail('ME@x.org')?.password).toBe('secret-pass');
    expect(b.remove(acc.id)).toBe(true);
    expect(new MailAccountsFile(file, box(), vi.fn()).all()).toEqual([]);
  });
  it('without OS encryption: memory only, one warning, nothing written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calab-mail-acc-'));
    dirs.push(dir);
    const file = join(dir, 'accounts.bin');
    const warn = vi.fn();
    const a = new MailAccountsFile(file, box(false), warn);
    a.put(acc);
    a.put({ ...acc, name: 'Me' });
    expect(a.all()[0]?.name).toBe('Me');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(file)).toThrow();
  });
});

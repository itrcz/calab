import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, protocol: {}, shell: {}, session: {} }));
vi.mock('../downloads', () => ({ markFromInternet: vi.fn(), uniquePath: vi.fn() }));
vi.mock('../logging', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

const { attachmentResponse, contentDisposition, fetchRemoteImage, isInlineMime, parseAttachmentUrl, parseRemoteUrl, REMOTE_MAX_BYTES } = await import('./attachmentProtocol');
const { decideFrameNavigation, parseMailto } = await import('./frameGuard');
const { MailAccountsFile } = await import('./accounts');
const { mailAttachmentUrl, mailRemoteImageUrl } = await import('../../shared/mail');

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

describe('calaba-mail://remote images', () => {
  it('round-trips http(s) URLs only', () => {
    const u = 'https://cdn.example.org/a.png?x=1&y=привет';
    expect(parseRemoteUrl(mailRemoteImageUrl(u))).toBe(new URL(u).href);
    expect(parseRemoteUrl(mailRemoteImageUrl('http://x.org/p.gif'))).toBe('http://x.org/p.gif');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'calaba-api://api/me', 'data:image/png;base64,AA']) {
      expect(parseRemoteUrl(mailRemoteImageUrl(bad)), bad).toBeNull();
    }
    expect(parseRemoteUrl('calaba-mail://remote/!!!')).toBeNull();
  });
  it('fetches without credentials / referrer, raster images only, size-capped', async () => {
    let init: RequestInit | undefined;
    const ok = await fetchRemoteImage('https://x.org/a.png', (_u, i) => {
      init = i;
      return Promise.resolve(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png; charset=binary' } }));
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    const svg = await fetchRemoteImage('https://x.org/a.svg', () => Promise.resolve(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })));
    expect(svg.status).toBe(415);
    const big = await fetchRemoteImage('https://x.org/b.png', () => Promise.resolve(new Response(new Uint8Array(REMOTE_MAX_BYTES + 1), { headers: { 'content-type': 'image/png' } })));
    expect(big.status).toBe(413);
    const down = await fetchRemoteImage('https://x.org/c.png', () => Promise.reject(new Error('offline')));
    expect(down.status).toBe(504);
  });
});

describe('frame guard decisions', () => {
  const inMail = { isMainFrame: false, frameUrl: 'about:srcdoc', selfInitiated: true };
  it('a link clicked inside a mail body: http(s) → browser, mailto → compose, other schemes blocked', () => {
    expect(decideFrameNavigation({ ...inMail, url: 'https://example.org/x' })).toEqual({ action: 'external', url: 'https://example.org/x' });
    expect(decideFrameNavigation({ ...inMail, url: 'mailto:a@b.org?subject=Hi%20there&cc=c@d.org' })).toEqual({
      action: 'compose',
      link: 'calab://mail/compose?to=a%40b.org&cc=c%40d.org&subject=Hi%20there',
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
  it('mailto → compose deep link: plain addresses only, no bcc, ≤ 512 chars', () => {
    expect(parseMailto('mailto:a+tag@b.org,bad,%3Cx%3E@y?body=line1%0Aline2&BCC=z@q.org')).toBe('calab://mail/compose?to=a%2Btag%40b.org&body=line1%0Aline2');
    const long = parseMailto(`mailto:a@b.org?subject=S&body=${'%F0%9F%98%80'.repeat(400)}`) ?? '';
    expect(long.length).toBeLessThanOrEqual(512);
    expect(long).toMatch(/^calab:\/\/mail\/compose\?to=a%40b\.org&subject=S&body=(%F0%9F%98%80)+$/);
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
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'mail')).mode & 0o777).toBe(0o700);
    }
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

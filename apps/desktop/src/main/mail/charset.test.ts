/**
 * Charset sniffing for single-byte cyrillic mail (unlabelled or mislabelled bodies, ADR-0088 §5):
 * unit fixtures use pre-recorded byte literals (no encoder dependency), the parseBody cases go
 * through real mailparser on hand-built .eml sources.
 */
import { describe, expect, it } from 'vitest';
import { sniffCharset, SniffingIconv } from './charset';
import { decodeCharset, decodePart, parseBody } from './mime';

const TEXT = 'Привет! Это письмо в однобайтовой кодировке, проверяем отображение русского текста в почтовом клиенте. С уважением, банк.';
const TEXT_EMOJI = 'Сообщение с эмодзи 🎉 и русский текст utf-8';
const ASCII = 'Hi there! Plain ascii body.';

// TEXT in windows-1251 / koi8-r, pre-recorded (TextDecoder never encodes).
const CP1251 = [207, 240, 232, 226, 229, 242, 33, 32, 221, 242, 238, 32, 239, 232, 241, 252, 236, 238, 32, 226, 32, 238, 228, 237, 238, 225, 224, 233, 242, 238, 226, 238, 233, 32, 234, 238, 228, 232, 240, 238, 226, 234, 229, 44, 32, 239, 240, 238, 226, 229, 240, 255, 229, 236, 32, 238, 242, 238, 225, 240, 224, 230, 229, 237, 232, 229, 32, 240, 243, 241, 241, 234, 238, 227, 238, 32, 242, 229, 234, 241, 242, 224, 32, 226, 32, 239, 238, 247, 242, 238, 226, 238, 236, 32, 234, 235, 232, 229, 237, 242, 229, 46, 32, 209, 32, 243, 226, 224, 230, 229, 237, 232, 229, 236, 44, 32, 225, 224, 237, 234, 46];
const KOI8 = [240, 210, 201, 215, 197, 212, 33, 32, 252, 212, 207, 32, 208, 201, 211, 216, 205, 207, 32, 215, 32, 207, 196, 206, 207, 194, 193, 202, 212, 207, 215, 207, 202, 32, 203, 207, 196, 201, 210, 207, 215, 203, 197, 44, 32, 208, 210, 207, 215, 197, 210, 209, 197, 205, 32, 207, 212, 207, 194, 210, 193, 214, 197, 206, 201, 197, 32, 210, 213, 211, 211, 203, 207, 199, 207, 32, 212, 197, 203, 211, 212, 193, 32, 215, 32, 208, 207, 222, 212, 207, 215, 207, 205, 32, 203, 204, 201, 197, 206, 212, 197, 46, 32, 243, 32, 213, 215, 193, 214, 197, 206, 201, 197, 205, 44, 32, 194, 193, 206, 203, 46];
const UTF8 = [...Buffer.from(TEXT, 'utf8')];
const UTF8_EMOJI = [...Buffer.from(TEXT_EMOJI, 'utf8')];

const bytes = (a: number[]): Uint8Array => Uint8Array.from(a);

describe('sniffCharset', () => {
  it('cp1251 without a label and with a wrong utf-8 label both read as cp1251', () => {
    expect(sniffCharset(bytes(CP1251), '')).toBe('windows-1251');
    expect(sniffCharset(bytes(CP1251), 'utf-8')).toBe('windows-1251');
    expect(sniffCharset(bytes(CP1251), 'x-unknown-charset')).toBe('windows-1251');
  });

  it('an honest windows-1251 label is kept', () => {
    expect(sniffCharset(bytes(CP1251), 'windows-1251')).toBe('windows-1251');
    // the alias normalizes to the canonical encoding
    expect(sniffCharset(bytes(CP1251), 'cp1251')).toBe('windows-1251');
  });

  it('utf-8 with emoji survives an empty label and an honest utf-8 label', () => {
    expect(sniffCharset(bytes(UTF8_EMOJI), '')).toBe('utf-8');
    expect(sniffCharset(bytes(UTF8_EMOJI), 'utf-8')).toBe('utf-8');
  });

  it('koi8-r without a label scores as koi8-r', () => {
    expect(sniffCharset(bytes(KOI8), '')).toBe('koi8-r');
    expect(sniffCharset(bytes(KOI8), 'utf-8')).toBe('koi8-r');
    expect(sniffCharset(bytes(KOI8), 'koi8-r')).toBe('koi8-r');
  });

  it('utf-8 bytes behind a windows-1251 label are recognized as utf-8', () => {
    expect(sniffCharset(bytes(UTF8), 'windows-1251')).toBe('utf-8');
    expect(sniffCharset(bytes(UTF8_EMOJI), 'windows-1251')).toBe('utf-8');
  });

  it('ascii is left alone under any label', () => {
    expect(sniffCharset(Buffer.from(ASCII, 'ascii'), '')).toBe('utf-8');
    expect(sniffCharset(Buffer.from(ASCII, 'ascii'), 'windows-1251')).toBe('windows-1251');
  });
});

describe('decodeCharset', () => {
  it('reads every production case as text', () => {
    expect(decodeCharset(bytes(CP1251), '')).toBe(TEXT);
    expect(decodeCharset(bytes(CP1251), 'utf-8')).toBe(TEXT);
    expect(decodeCharset(bytes(CP1251), 'windows-1251')).toBe(TEXT);
    expect(decodeCharset(bytes(KOI8), 'utf-8')).toBe(TEXT);
    expect(decodeCharset(bytes(UTF8), 'windows-1251')).toBe(TEXT);
    expect(decodeCharset(bytes(UTF8_EMOJI), '')).toBe(TEXT_EMOJI);
    expect(decodeCharset(Buffer.from(ASCII, 'ascii'), 'utf-8')).toBe(ASCII);
  });

  it('no case leaves replacement characters behind', () => {
    for (const [raw, label] of [
      [CP1251, ''], [CP1251, 'utf-8'], [CP1251, 'windows-1251'], [CP1251, 'x-unknown-charset'],
      [KOI8, ''], [KOI8, 'utf-8'],
      [UTF8, 'windows-1251'], [UTF8_EMOJI, ''],
    ] as Array<[number[], string]>) {
      expect(decodeCharset(bytes(raw), label).includes('�'), label).toBe(false);
    }
  });

  it('feeds the snippet path: quoted-printable cp1251 part decodes to text', () => {
    const qp = [...CP1251].map((b) => (b > 0x7f || b === 0x3d ? `=${b.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(b))).join('');
    expect(decodePart(Buffer.from(qp, 'latin1'), 'quoted-printable', 'utf-8')).toBe(TEXT);
  });
});

describe('SniffingIconv', () => {
  function pump(input: number[] | Uint8Array, chunkSize: number, declared = 'windows-1251'): Promise<string> {
    const stream = new SniffingIconv(declared, 'UTF-8//TRANSLIT//IGNORE');
    const out: Buffer[] = [];
    const done = new Promise<string>((resolve, reject) => {
      stream.on('data', (c: Buffer) => out.push(c));
      stream.on('end', () => resolve(Buffer.concat(out).toString('utf8')));
      stream.on('error', reject);
    });
    const buf = Buffer.from(input);
    for (let i = 0; i < buf.length; i += chunkSize) stream.write(buf.subarray(i, i + chunkSize));
    stream.end();
    return done;
  }

  it('locks onto cp1251 from the first chunk and decodes the whole stream', async () => {
    await expect(pump(CP1251, 4096)).resolves.toBe(TEXT);
    await expect(pump(CP1251, 7)).resolves.toBe(TEXT);
    // an unknown label (the retagged "x-calaba-sniff") must sniff just the same
    await expect(pump(CP1251, 16, 'x-calaba-sniff')).resolves.toBe(TEXT);
  });

  it('buffers a sub-sniff-threshold part and decides at flush', async () => {
    await expect(pump(CP1251.slice(0, 12), 5)).resolves.toBe('Привет! Это ');
  });

  it('forwards valid utf-8 bytes untouched, emoji included', async () => {
    await expect(pump(UTF8, 5)).resolves.toBe(TEXT);
    await expect(pump(UTF8_EMOJI, 3)).resolves.toBe(TEXT_EMOJI);
  });

  it('koi8-r bytes behind a koi8-r label stay koi8-r', async () => {
    await expect(pump(KOI8, 9, 'koi8-r')).resolves.toBe(TEXT);
  });
});

describe('parseBody', () => {
  const eml = (contentType: string, body: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(
        `From: =?utf-8?B?${Buffer.from('Отправитель', 'utf8').toString('base64')}?= <from@example.com>\r\n` +
          `To: <to@example.com>\r\n` +
          `Subject: =?utf-8?B?${Buffer.from('Тема письма', 'utf8').toString('base64')}?=\r\n` +
          `Date: Wed, 14 Oct 2026 10:00:00 +0300\r\n` +
          `MIME-Version: 1.0\r\n${contentType}\r\n\r\n`,
        'utf8',
      ),
      body,
    ]);

  it('cp1251 body without a charset label (bank gateway case)', async () => {
    const p = await parseBody(eml('Content-Type: text/plain; format=flowed', Buffer.from(CP1251)));
    expect(p.body.text).toBe(TEXT);
  });

  it('cp1251 body mislabelled as utf-8', async () => {
    const p = await parseBody(eml('Content-Type: text/plain; charset="utf-8"', Buffer.from(CP1251)));
    expect(p.body.text).toBe(TEXT);
  });

  it('honest windows-1251 and koi8-r labels parse untouched', async () => {
    await expect(parseBody(eml('Content-Type: text/plain; charset=windows-1251', Buffer.from(CP1251)))).resolves.toMatchObject({ body: { text: TEXT } });
    await expect(parseBody(eml('Content-Type: text/plain; charset=koi8-r', Buffer.from(KOI8)))).resolves.toMatchObject({ body: { text: TEXT } });
  });

  it('utf-8 body behind a windows-1251 label is laid back onto utf-8', async () => {
    const p = await parseBody(eml('Content-Type: text/plain; charset=windows-1251', Buffer.from(UTF8)));
    expect(p.body.text).toBe(TEXT);
  });

  it('honest utf-8 (html, emoji) still parses and attachments are untouched', async () => {
    const html = '<html><body><p>Отчёт 🎉 готов</p></body></html>';
    const src = Buffer.from(
      `From: <from@example.com>\r\nTo: <to@example.com>\r\nSubject: r\r\nMIME-Version: 1.0\r\n` +
        `Content-Type: multipart/mixed; boundary=BOUND\r\n\r\n--BOUND\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--BOUND\r\n` +
        `Content-Type: application/pdf; name=a.pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nSU5UQ0xVU0lWRQ==\r\n--BOUND--\r\n`,
      'utf8',
    );
    const p = await parseBody(src);
    expect(p.body.html).toBe(html);
    expect(p.body.text).toContain('Отчёт 🎉 готов');
    expect(p.attachments.map((a) => Buffer.from(a.data).toString())).toEqual(['INTCLUSIVE']);
  });
});

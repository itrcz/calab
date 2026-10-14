// @vitest-environment jsdom
import { afterAll, describe, expect, it } from 'vitest';
import type { MailMessage } from '../../../shared/mail';
import { setLocale } from '../../i18n';
import { inlineImages } from './compose';
import { attribution, draftFrom, editorHtmlForSend, editorHtmlToText, initialEditorHtml, quoteBlock, sanitizeForEditor, textToEditorHtml } from './editor';

const orig = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'a1.m1',
  threadId: 'a1.t1',
  accountId: 'a1',
  folderId: 'a1.f1',
  messageIdHeader: '<m1@x>',
  from: { name: 'Анна Петрова', address: 'anna@x.io' },
  to: [{ name: '', address: 'me@x.io' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Бюджет',
  snippet: 'Привет',
  date: new Date(2026, 9, 12, 13, 28).getTime(),
  flags: { seen: true, flagged: false, answered: false },
  hasAttachments: false,
  size: 100,
  html: null,
  text: 'Привет\nКак дела?',
  attachments: [],
  inReplyTo: '',
  references: [],
  remoteImages: false,
  ...over,
});

const noCid = { remote: false, cid: () => null };

afterAll(async () => {
  await setLocale('ru');
});

describe('editor HTML → text (the text/plain part)', () => {
  it('paragraphs, line breaks and empty lines', () => {
    expect(editorHtmlToText('<p>Hello</p><p><br></p><p>Second<br>line</p>')).toBe('Hello\n\nSecond\nline');
    expect(editorHtmlToText('<div>one</div><div>two</div>')).toBe('one\ntwo');
  });
  it('blockquotes as `> ` lines, nested ones `>>`', () => {
    expect(editorHtmlToText('<p>Ok</p><p>Anna wrote:</p><blockquote><p>a</p><p>b</p><blockquote><p>c</p></blockquote></blockquote>')).toBe('Ok\nAnna wrote:\n> a\n> b\n>> c');
  });
  it('links as «text (url)», a bare link once', () => {
    expect(editorHtmlToText('<p>See <a href="https://x.io/doc">the doc</a> and <a href="https://x.io">https://x.io</a>, <a href="mailto:a@x.io">a@x.io</a></p>')).toBe(
      'See the doc (https://x.io/doc) and https://x.io, a@x.io',
    );
  });
  it('a typed text round-trips', () => {
    expect(editorHtmlToText(textToEditorHtml('a <b>\n\nc'))).toBe('a <b>\n\nc');
  });
});

describe('quote in the editor (Apple Mail)', () => {
  it('reply: an empty first line, the signature, the attribution and an editable blockquote of the original', async () => {
    await setLocale('ru');
    const html = initialEditorHtml({ signature: 'Иван', quote: quoteBlock(orig(), 'reply', noCid) });
    expect(html.startsWith('<p><br></p>')).toBe(true);
    const el = document.createElement('div');
    el.innerHTML = html;
    const q = el.querySelector('blockquote');
    expect(q?.textContent).toContain('Как дела?');
    expect(el.textContent).toContain('12 окт. 2026 в 13:28 Анна Петрова <anna@x.io> написал(а):');
    expect(html.indexOf('Иван')).toBeLessThan(html.indexOf('<blockquote'));
  });
  it('the attribution follows the locale', async () => {
    const at = orig().date;
    await setLocale('en');
    expect(attribution(orig().from, at)).toMatch(/^On Oct 12, 2026, at .+, Анна Петрова <anna@x\.io> wrote:$/);
    await setLocale('es');
    expect(attribution(orig().from, at)).toMatch(/^El .*2026, a las .* Анна Петрова <anna@x\.io> escribió:$/);
    await setLocale('zh-CN');
    expect(attribution(orig().from, at)).toMatch(/2026.*Анна Петрова <anna@x\.io> 写道：$/);
    await setLocale('ru');
  });
  it('the original HTML is sanitized for the editor: no scripts, handlers, styles, classes, remote images; cid via the attachment URL', () => {
    const html = quoteBlock(
      orig({
        html: '<style>body{display:none}</style><p class="fixed inset-0" id="x" onclick="steal()" style="position:fixed;color:red">Hi<script>alert(1)</script></p><img src="https://t.example/p.gif"><img src="cid:logo">',
        attachments: [{ id: '2', name: 'logo.png', mime: 'image/png', size: 10, cid: 'logo', inline: true }],
      }),
      'forward',
      { remote: false, cid: (c) => (c === 'logo' ? 'calaba-mail://attachment/a1.m1/2' : null) },
    );
    expect(html).not.toMatch(/<style|script|onclick|class=|id="x"|position|https:\/\/t\.example/);
    expect(html).toContain('color:red');
    expect(html).toContain('src="calaba-mail://attachment/a1.m1/2"');
    expect(html).toContain('Анна Петрова &lt;anna@x.io&gt;');
  });
});

describe('sanitize on send', () => {
  it('strips scripts and handlers the editor DOM might hold, keeps the quote styled', () => {
    const out = editorHtmlForSend('<p onmouseover="x()">Hi</p><img src=x onerror="alert(1)"><script>1</script><blockquote><p>q</p></blockquote><a href="javascript:alert(1)">l</a>', { local: false });
    expect(out).not.toMatch(/onmouseover|onerror|<script|javascript:/);
    expect(out).toContain('<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">');
  });
  it('local attachment images go only into a saved draft, never into a sent message', () => {
    const src = '<p>x</p><img src="calaba-mail://attachment/a1.m1/2">';
    expect(editorHtmlForSend(src, { local: true })).toContain('calaba-mail://attachment/a1.m1/2');
    expect(editorHtmlForSend(src, { local: false })).not.toContain('calaba-mail:');
    expect(sanitizeForEditor(src, noCid)).not.toContain('calaba-mail:');
  });
  it('a forward carries the inline images still in the text as attachments', () => {
    const m = orig({ attachments: [{ id: '2', name: 'logo.png', mime: 'image/png', size: 10, cid: 'logo', inline: true }, { id: '3', name: 'gone.png', mime: 'image/png', size: 10, cid: 'g', inline: true }] });
    const inline = inlineImages(m, (mid, aid) => `calaba-mail://attachment/${mid}/${aid}`);
    const form = { accountId: 'a1', to: [{ name: '', address: 'b@x.io' }], cc: [], bcc: [], subject: 'Fwd: x', ref: { messageId: m.id, kind: 'forward' as const, quote: false }, attachments: [] };
    const d = draftFrom(form, '<p>fyi</p><blockquote><img src="calaba-mail://attachment/a1.m1/2"></blockquote>', inline, true);
    expect(d.attachments.map((a) => a.id)).toEqual(['a1.m1:2']);
    expect(d.text).toBe('fyi');
    expect(d.html).not.toContain('calaba-mail:');
    expect(d.ref?.quote).toBe(false);
  });
});

describe('«Отправить в чат…» text', () => {
  it('subject, sender, date, a blank line and the text cut with «…»', async () => {
    const { chatText, emlName } = await import('./chatText');
    await setLocale('ru');
    const long = 'а'.repeat(2000);
    const out = chatText(orig({ text: `Первая строка\r\n\r\n\r\n${long}` }), 1500);
    const lines = out.split('\n');
    expect(lines[0]).toBe('📧 Бюджет');
    expect(lines[1]).toBe('От: Анна Петрова <anna@x.io>');
    expect(lines[2]).toMatch(/^Дата: /);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('Первая строка');
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(1500 + 120);
    expect(chatText(orig({ subject: '', text: '' }))).toBe(`📧 (без темы)\nОт: Анна Петрова <anna@x.io>\nДата: ${lines[2]?.slice(6) ?? ''}`);
    expect(emlName('Re: план / релиз?')).toBe('Re план релиз.eml');
  });
});

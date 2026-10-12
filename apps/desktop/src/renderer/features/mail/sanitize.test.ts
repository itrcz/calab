// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mailRemoteImageUrl } from '../../../shared/mail';
import { linkify, MAIL_CSP, mailCsp, mailSrcdoc, sanitizeCss, sanitizeMailHtml, type SanitizeOptions } from './sanitize';

const opts = (remote = false): SanitizeOptions => ({ remote, cid: (id) => (id === 'logo@x' ? 'calaba-mail://attachment/m1/a1' : null) });
const clean = (html: string, remote = false) => sanitizeMailHtml(html, opts(remote));

describe('sanitizeMailHtml (ADR-0088 §10)', () => {
  it('drops scripts, handlers, javascript: links and active elements', () => {
    const { html } = clean(
      '<p onclick="steal()">Hi<script>alert(1)</script></p><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>' +
        '<iframe src="https://evil"></iframe><object data="x"></object><embed src="x"><form action="https://evil"><input name=p></form>' +
        '<link rel=stylesheet href="https://evil/x.css"><meta http-equiv=refresh content="0;url=https://evil"><base href="https://evil/"><svg><script>1</script></svg>',
    );
    expect(html).not.toMatch(/script|onclick|onerror|javascript:|iframe|object|embed|<form|<input|<link|<meta|<base|<svg/i);
    expect(html).toContain('Hi');
  });

  it('rewrites cid: images to attachment URLs and drops unknown cids', () => {
    const { html } = clean('<img src="cid:logo@x"><img src="cid:%3Clogo@x%3E"><img src="cid:other">');
    expect(html.match(/calaba-mail:\/\/attachment\/m1\/a1/g)).toHaveLength(2);
    expect(html).not.toContain('cid:');
  });

  it('blocks remote images and CSS url() unless allowed, and counts them', () => {
    const src = '<img src="https://track.example/p.gif"><div style="background:url(https://x.example/bg.png);color:red">t</div><table background="http://x.example/t.png"></table>';
    const off = clean(src);
    expect(off.html).not.toMatch(/https?:\/\//);
    expect(off.html).toContain('color:red');
    expect(off.blocked).toBe(3);
    // Allowed: through main's cookie-less fetch (calaba-mail://remote/…), never straight from https.
    const on = clean(src, true);
    expect(on.html).not.toMatch(/https?:\/\//);
    expect(on.html).toContain(`src="${mailRemoteImageUrl('https://track.example/p.gif')}"`);
    expect(on.html).toContain(`url(&quot;${mailRemoteImageUrl('https://x.example/bg.png')}&quot;)`);
    expect(on.html).toContain(`background="${mailRemoteImageUrl('http://x.example/t.png')}"`);
    expect(on.blocked).toBe(0);
  });

  it('keeps head <style> (rewritten) and removes @import', () => {
    const { html, blocked } = clean('<html><head><style>@import url(https://evil/x.css); .a{background:url(https://x/y.png)} .b{color:blue}</style></head><body><p class="a">t</p></body></html>');
    expect(html).toMatch(/^<style>/);
    expect(html).not.toContain('@import');
    expect(html).toContain('.b{color:blue}');
    expect(html).not.toContain('https://x/y.png');
    expect(blocked).toBe(1);
  });

  it('normalizes links: no target, rel noopener, only http(s) / mailto hrefs', () => {
    const { html } = clean('<a href="https://ok.example" target="_blank">a</a><a href="mailto:x@y.z" target="_top">b</a><a href="file:///etc/passwd">c</a><a href="calab://mail/abc">d</a>');
    expect(html).not.toContain('target=');
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="mailto:x@y.z"');
    expect(html).not.toContain('file:');
    expect(html).not.toContain('calab:');
  });

  it('keeps inline data: images but not other data: URLs', () => {
    const { html } = clean('<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).not.toContain('data:text/html');
  });
});

describe('sanitizeCss', () => {
  it('drops expressions and bindings', () => {
    expect(sanitizeCss('width:expression(alert(1));-moz-binding:url(x.xml#b);color:red', opts())).not.toMatch(/expression|binding|x\.xml/);
  });
});

describe('own colours (dark theme, §8)', () => {
  it('a plain HTML message is not styled; colours, backgrounds, bgcolor and <font color> are', () => {
    expect(clean('<div dir="ltr">Hi<br><a href="https://a.example">a</a></div><blockquote style="border-left:1px solid #ccc;margin:0">q</blockquote>').styled).toBe(false);
    expect(clean('<p style="color:#333">x</p>').styled).toBe(true);
    expect(clean('<p style="border-color:red;background: transparent">x</p>').styled).toBe(false);
    expect(clean('<table bgcolor="#f4f4f4"><tr><td>x</td></tr></table>').styled).toBe(true);
    expect(clean('<font color="red">x</font>').styled).toBe(true);
    expect(clean('<html><head><style>.a{background-color:#fff}</style></head><body><p class="a">x</p></body></html>').styled).toBe(true);
    expect(clean('<html><body style="background:#eee"><p>x</p></body></html>').styled).toBe(true);
  });

  it('showing remote images does not change the verdict', () => {
    const src = '<div style="background:url(https://x.example/bg.png)">t</div>';
    expect(clean(src).styled).toBe(clean(src, true).styled);
  });
});

describe('srcdoc', () => {
  it('starts with the CSP meta and never allows https:', () => {
    expect(mailSrcdoc('<p>x</p>')).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: calaba-mail:\/\/attachment; style-src 'unsafe-inline'">/);
    expect(MAIL_CSP).not.toContain('https:');
  });

  it('the remote-image proxy is in the CSP only after consent (CSS the rewrite misses stays blocked)', () => {
    // CSS forms a regex rewrite can miss: the CSP keeps them from reaching the proxy.
    const sneaky = clean('<p style="background:image-set(\'calaba-mail://remote/abc\' 1x)">a</p><p style="background:\\75rl(calaba-mail://remote/abc)">b</p>');
    const before = mailSrcdoc(sneaky.html);
    expect(before).toContain("img-src data: calaba-mail://attachment;");
    expect(before).not.toMatch(/img-src[^;]*(calaba-mail:\/\/remote|calaba-mail:[ ;])/);
    expect(mailSrcdoc('<p>x</p>', null, true)).toContain("img-src data: calaba-mail://attachment calaba-mail://remote;");
    expect(mailCsp(true)).not.toContain('https:');
  });

  it('a styled message gets the white page, a plain one the theme colours (literals only)', () => {
    expect(mailSrcdoc('<p>x</p>')).toContain('color-scheme:light}body{color:#1d1d1f;background:#fff}');
    const dark = mailSrcdoc('<p>x</p>', { scheme: 'dark', fg: 'rgb(236, 236, 240)', muted: 'rgb(180, 180, 185)', link: 'rgb(64, 156, 255)', line: 'rgba(255, 255, 255, 0.08)' });
    expect(dark).toContain('html{color-scheme:dark}body{color:rgb(236, 236, 240);background:transparent}a{color:rgb(64, 156, 255)}');
    const evil = mailSrcdoc('<p>x</p>', { scheme: 'dark', fg: 'red}</style><script>', muted: '', link: '', line: '' });
    expect(evil).not.toContain('<script>');
    expect(evil).toContain('body{color:#ececf0;');
  });
});

describe('linkify', () => {
  it('splits links and addresses, leaving trailing punctuation as text', () => {
    expect(linkify('See https://a.example/x, or write to bob@b.example.')).toEqual([
      { text: 'See ' },
      { href: 'https://a.example/x', text: 'https://a.example/x' },
      { text: ', or write to ' },
      { href: 'mailto:bob@b.example', text: 'bob@b.example' },
      { text: '.' },
    ]);
    expect(linkify('no links')).toEqual([{ text: 'no links' }]);
  });
});

import type { MailAddress, MailDraft, MailDraftAttachment, MailMessage } from '../../../shared/mail';
import { getLocale, t } from '../../i18n';
import { fmt } from '../../lib/format';
import { purifierFor, sanitizeMailHtml, type SanitizeOptions } from './sanitize';
import type { DOMPurify as Purifier } from 'dompurify';

/**
 * The composer's body (owner 12.10, Apple Mail): one `contenteditable` with the typed paragraphs and,
 * for a reply / forward, the original as an editable `<blockquote>` under an attribution line.
 * Everything that enters the editor is sanitized here (the original is hostile HTML); what leaves it
 * on send is sanitized again with the same profile, and the plain-text part is derived from it.
 * Pure DOM helpers (jsdom-tested), no React.
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The empty first line the caret starts on. */
export const EMPTY_LINE = '<p><br></p>';

/** Plain text → editor paragraphs: one `<p>` per line, an empty line is an empty paragraph. */
export function textToEditorHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.map((l) => (l.trim() ? `<p>${esc(l)}</p>` : EMPTY_LINE)).join('');
}

/** Attributes a hostile original could use to reach the app's CSS or behaviour inside our document. */
const DROP_ATTRS = ['class', 'id', 'name', 'contenteditable', 'tabindex', 'accesskey', 'draggable', 'spellcheck', 'role', 'slot', 'part'];
/** Layout that could escape the editor box (it is also `contain: paint`): never kept. */
const ESCAPING_CSS = /(?:^|;)\s*(?:position|z-index|inset|top|left|right|bottom|transform|translate|filter|backdrop-filter)\s*:[^;]*/gi;

/** A detached, inert container (a `<template>`: nothing loads or runs while we rewrite it). */
function inert(html: string): HTMLTemplateElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl;
}

/**
 * Sanitized HTML for the editor: the reader's profile (sanitize.ts: no scripts, handlers, forms,
 * frames; remote images removed; `cid:` → the attachment URL), and on top — the editor lives in the
 * app's document, not a sandboxed frame — no `<style>` elements, no class / id (the app's CSS must
 * not apply), no positioning out of the box.
 */
export function sanitizeForEditor(html: string, opts: SanitizeOptions & { local?: boolean }, purify?: Purifier): string {
  const clean = sanitizeMailHtml(opts.local ? keepLocal(html) : html, opts.local ? { ...opts, cid: (id) => localCid(id) ?? opts.cid(id) } : opts, purify ?? purifierFor()).html;
  const tpl = inert(clean);
  for (const el of Array.from(tpl.content.querySelectorAll('style, link, meta, title'))) el.remove();
  for (const el of Array.from(tpl.content.querySelectorAll('*'))) {
    for (const a of DROP_ATTRS) el.removeAttribute(a);
    const style = el.getAttribute('style');
    if (style !== null) {
      const kept = style.replace(ESCAPING_CSS, '').replace(/^\s*;+/, '').trim();
      if (kept) el.setAttribute('style', kept);
      else el.removeAttribute('style');
    }
  }
  return tpl.innerHTML;
}

/**
 * A saved draft's own images (`calaba-mail://attachment/<message>/<attachment>`, a forward's inline
 * ones): DOMPurify drops the unknown scheme, so they pass the sanitizer as a marked `cid:` and come
 * back through the `cid` hook — only this exact shape, only when re-reading our own editor.
 */
const LOCAL_SRC = /(\ssrc\s*=\s*)(["'])calaba-mail:\/\/attachment\/([\w.%-]+)\/([\w.%-]+)\2/gi;
const LOCAL_MARK = 'calab-local:';
const keepLocal = (html: string): string => html.replace(LOCAL_SRC, (_m, pre: string, q: string, mid: string, aid: string) => `${pre}${q}cid:${LOCAL_MARK}${mid}/${aid}${q}`);
function localCid(id: string): string | null {
  if (!id.startsWith(LOCAL_MARK)) return null;
  // The sanitizer URI-decodes a cid: encode the ids again, as `mailAttachmentUrl` does.
  const m = /^(.+)\/([^/]+)$/.exec(id.slice(LOCAL_MARK.length));
  return m ? `calaba-mail://attachment/${encodeURIComponent(m[1] ?? '')}/${encodeURIComponent(m[2] ?? '')}` : null;
}

/** «12 окт. 2026» / “Oct 12, 2026”: the attribution date, with the year. */
function attributionDate(d: Date): string {
  const parts = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(d);
  if (getLocale() !== 'ru') return parts.map((p) => p.value).join('');
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}

const fullAddress = (a: MailAddress): string => (a.name.trim() ? `${a.name.trim()} <${a.address}>` : a.address);

/** «12 окт. 2026 в 13:28 Имя <адрес> написал(а):» in the UI locale. */
export function attribution(from: MailAddress, date: number): string {
  const d = new Date(date);
  return t('mbox.quoteAttribution', { date: attributionDate(d), time: fmt.time(d), name: fullAddress(from) });
}

/** The quoted original: the attribution (reply) or the forward header, then the blockquote. */
export function quoteBlock(orig: Pick<MailMessage, 'from' | 'to' | 'date' | 'subject' | 'html' | 'text' | 'snippet'>, kind: 'reply' | 'replyAll' | 'forward', opts: SanitizeOptions, purify?: Purifier): string {
  const body = orig.html ? sanitizeForEditor(orig.html, opts, purify) : textToEditorHtml(orig.text ?? orig.snippet);
  if (kind === 'forward') {
    const head = [
      `<b>${esc(t('mbox.from'))}:</b> ${esc(fullAddress(orig.from))}`,
      `<b>${esc(t('mbox.subject'))}:</b> ${esc(orig.subject)}`,
      `<b>${esc(t('mbox.date'))}:</b> ${esc(`${attributionDate(new Date(orig.date))}, ${fmt.time(new Date(orig.date))}`)}`,
      `<b>${esc(t('mbox.to'))}:</b> ${esc(orig.to.map(fullAddress).join(', '))}`,
    ].join('<br>');
    return `<p>${esc(t('mbox.fwdIntro'))}</p><blockquote type="cite"><p>${head}</p>${EMPTY_LINE}${body}</blockquote>`;
  }
  return `<p>${esc(attribution(orig.from, orig.date))}</p><blockquote type="cite">${body}</blockquote>`;
}

/** The signature block (RFC 3676 «-- » line), as editor paragraphs. */
export function signatureHtml(signature: string): string {
  const sig = signature.trim();
  if (!sig) return '';
  return `<p>-- <br>${sig.split(/\r?\n/).map(esc).join('<br>')}</p>`;
}

/**
 * The editor's starting content: the caret line on top (or the given text), then the signature under
 * an empty line, then the quote under another — Apple Mail's layout.
 */
export function initialEditorHtml(parts: { text?: string; signature?: string; quote?: string }): string {
  const top = parts.text?.trim() ? textToEditorHtml(parts.text) : EMPTY_LINE;
  const sig = parts.signature ? signatureHtml(parts.signature) : '';
  return `${top}${sig ? `${EMPTY_LINE}${sig}` : ''}${parts.quote ? `${EMPTY_LINE}${parts.quote}` : ''}`;
}

// ---------------------------------------------------------------- leaving the editor

const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'PRE', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ADDRESS', 'CENTER', 'HR', 'DL', 'DT', 'DD', 'FIGURE']);
const SKIP = new Set(['STYLE', 'SCRIPT', 'HEAD', 'TITLE', 'TEMPLATE', 'NOSCRIPT']);

/** Text of a node: blocks on their own lines, `<br>` a line break, blockquotes `> `, links «text (url)». */
function textOf(node: Node, pre: boolean): string {
  if (node.nodeType === 3) {
    const v = (node.nodeValue ?? '').replace(/\u00a0/g, ' ');
    return pre ? v : v.replace(/[\t\n\r ]+/g, ' ');
  }
  if (node.nodeType !== 1 && node.nodeType !== 11) return '';
  const el = node as Element;
  const tag = node.nodeType === 1 ? el.tagName : '';
  if (SKIP.has(tag)) return '';
  if (tag === 'BR') return '\n';
  if (tag === 'IMG') return '';
  const inPre = pre || tag === 'PRE';
  let inner = '';
  for (const c of Array.from(node.childNodes)) {
    const part = textOf(c, inPre);
    // A block starts on a fresh line.
    if (c.nodeType === 1 && (BLOCKS.has((c as Element).tagName) || (c as Element).tagName === 'BLOCKQUOTE') && inner && !inner.endsWith('\n')) inner += '\n';
    inner += part;
  }
  if (tag === 'A') {
    const href = el.getAttribute('href') ?? '';
    const label = inner.trim();
    const bare = href.replace(/^mailto:/i, '');
    if (href && /^(https?:|mailto:)/i.test(href) && label !== href && label !== bare) return `${inner} (${bare})`;
    return inner;
  }
  if (tag === 'BLOCKQUOTE') {
    const body = tidy(inner).replace(/\n+$/, '');
    if (!body.trim()) return '';
    const quoted = body
      .split('\n')
      .map((l) => (l.startsWith('>') ? `>${l}` : l ? `> ${l}` : '>'))
      .join('\n');
    return `${quoted}\n`;
  }
  if (tag === 'LI') return `- ${inner.replace(/\n$/, '')}\n`;
  if (tag === 'TD' || tag === 'TH') return `${inner} `;
  if (BLOCKS.has(tag)) return `${inner.endsWith('\n') ? inner.slice(0, -1) : inner}\n`;
  return inner;
}

/** Line ends without the spaces that HTML whitespace collapsing leaves around breaks. */
const tidy = (s: string): string => s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');

/** The plain-text part of the editor's HTML (the `text/plain` alternative and the drafts list preview). */
export function editorHtmlToText(html: string): string {
  return tidy(textOf(inert(html).content, false))
    .replace(/^[ \t]+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

/** Blockquotes as mail clients draw them (Apple Mail / Gmail look at `type=cite` + this inline style). */
const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex';

/**
 * The editor's HTML for sending / saving: the same sanitizer as on the way in. For sending
 * (`local: false`) images of our own attachment protocol are dropped — they mean nothing outside this
 * computer (forwarded inline images travel as attachments, see `inlineImageRefs`).
 */
export function editorHtmlForSend(html: string, opts: { local: boolean }, purify?: Purifier): string {
  const clean = sanitizeForEditor(html, { remote: false, cid: () => null, local: opts.local }, purify);
  if (opts.local) return clean;
  const tpl = inert(clean);
  for (const q of Array.from(tpl.content.querySelectorAll('blockquote'))) {
    q.setAttribute('type', 'cite');
    q.setAttribute('style', QUOTE_STYLE);
  }
  return tpl.innerHTML;
}

/** `src`s of the images still in the editor (to carry a forward's inline images as attachments). */
export function imageSources(html: string): string[] {
  return Array.from(inert(html).content.querySelectorAll('img'))
    .map((i) => i.getAttribute('src') ?? '')
    .filter(Boolean);
}

// ---------------------------------------------------------------- the draft

/** What the composer edits besides the body (the body lives in the editor's DOM, read on send / save). */
export interface ComposeFields {
  id?: string;
  accountId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  ref?: MailDraft['ref'];
  attachments: MailDraftAttachment[];
}

/** The draft to send / save: the editor's HTML (sanitized again) and the text derived from it. */
export function draftFrom(form: ComposeFields, editorHtml: string, inline: Map<string, MailDraftAttachment>, forSend: boolean): MailDraft {
  const html = editorHtmlForSend(editorHtml, { local: !forSend });
  const text = editorHtmlToText(html);
  const attachments = [...form.attachments];
  if (forSend && inline.size) {
    const have = new Set(attachments.map((a) => a.id));
    for (const src of imageSources(editorHtml)) {
      const a = inline.get(src);
      if (a && !have.has(a.id)) {
        have.add(a.id);
        attachments.push(a);
      }
    }
  }
  return {
    ...(form.id ? { id: form.id } : {}),
    accountId: form.accountId,
    to: form.to,
    cc: form.cc,
    bcc: form.bcc,
    subject: form.subject,
    text,
    html,
    ...(form.ref ? { ref: form.ref } : {}),
    attachments,
  };
}


import type { MailMessage } from '../../../shared/mail';
import { t } from '../../i18n';
import { addressFull, mailHeaderTime } from './format';

/** «Отправить в чат…» (owner 12.10): the chat message's text and the .eml file name. Pure. */

/** The chat text of a message: «📧 Тема», «От: …», «Дата: …», a blank line, the text cut at ~`limit` chars. */
export function chatText(m: Pick<MailMessage, 'subject' | 'from' | 'date' | 'text' | 'snippet'>, limit = 1500): string {
  const head = [`📧 ${m.subject.trim() || t('mbox.noSubject')}`, `${t('mbox.from')}: ${addressFull(m.from)}`, `${t('mbox.date')}: ${mailHeaderTime(m.date)}`].join('\n');
  const text = (m.text ?? m.snippet)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return head;
  const body = text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
  return `${head}\n\n${body}`;
}

/** A file name from the subject: no path separators or control characters, ≤ 80 chars, `.eml`. */
export function emlName(subject: string): string {
  const base = subject
    // eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not carry
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return `${base || 'message'}.eml`;
}

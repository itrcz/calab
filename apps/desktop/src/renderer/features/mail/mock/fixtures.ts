import type { MailAccount, MailAddress, MailAttachment, MailFolder, MailFolderRole } from '../../../../shared/mail';

/**
 * Deterministic mock mailbox (ADR-0088 §7 mock): two accounts, standard folders, ~60 threads in
 * Russian and English. Fixed dates (no Date.now()) so screenshots are stable.
 */

/** «Now» of the fixtures: 12 Oct 2026, 09:00 UTC. */
export const MOCK_NOW = Date.UTC(2026, 9, 12, 9, 0);
const H = 3600_000;

/** A 1×1 PNG for inline / attachment images in the mock. */
export const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface MockMessage {
  id: string;
  threadId: string;
  accountId: string;
  folderId: string;
  messageIdHeader: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  date: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  html: string | null;
  text: string | null;
  attachments: MailAttachment[];
  inReplyTo: string;
  references: string[];
  remoteImages: boolean;
}

export const ROLES: MailFolderRole[] = ['inbox', 'starred', 'sent', 'drafts', 'outbox', 'archive', 'junk', 'trash'];

const GMAIL_PATHS: Record<MailFolderRole, string> = {
  inbox: 'INBOX',
  starred: '[Gmail]/Starred',
  sent: '[Gmail]/Sent Mail',
  drafts: '[Gmail]/Drafts',
  outbox: '',
  archive: '[Gmail]/All Mail',
  junk: '[Gmail]/Spam',
  trash: '[Gmail]/Trash',
};
const IMAP_PATHS: Record<MailFolderRole, string> = {
  inbox: 'INBOX',
  starred: '',
  sent: 'Отправленные',
  drafts: 'Черновики',
  outbox: '',
  archive: 'Архив',
  junk: 'Спам',
  trash: 'Корзина',
};

export const folderId = (accountId: string, role: string): string => `${accountId}/${role}`;

function makeFolders(accountId: string, paths: Record<MailFolderRole, string>, extra: string[]): MailFolder[] {
  const list: MailFolder[] = ROLES.map((role) => ({
    id: folderId(accountId, role),
    accountId,
    path: paths[role],
    name: paths[role].split('/').pop() || role,
    role,
    parentId: null,
    unread: 0,
    total: 0,
  }));
  for (const name of extra) {
    list.push({ id: folderId(accountId, name), accountId, path: name, name, role: null, parentId: null, unread: 0, total: 0 });
  }
  return list;
}

export function mockAccounts(): MailAccount[] {
  return [
    {
      id: 'acc-gmail',
      email: 'anna.petrova@gmail.com',
      name: 'Анна Петрова',
      provider: 'gmail',
      imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
      login: 'anna.petrova@gmail.com',
      state: 'idle',
      error: null,
      lastSyncAt: MOCK_NOW - 60_000,
    },
    {
      id: 'acc-work',
      email: 'anna@northwind.example',
      name: 'Anna Petrova',
      provider: 'other',
      imap: { host: 'mail.northwind.example', port: 993, security: 'tls' },
      smtp: { host: 'mail.northwind.example', port: 587, security: 'starttls' },
      login: 'anna@northwind.example',
      state: 'idle',
      error: null,
      lastSyncAt: MOCK_NOW - 120_000,
    },
  ];
}

export function mockFolders(): MailFolder[] {
  return [...makeFolders('acc-gmail', GMAIL_PATHS, []), ...makeFolders('acc-work', IMAP_PATHS, ['Проекты', 'Бухгалтерия'])];
}

const ANNA_G: MailAddress = { name: 'Анна Петрова', address: 'anna.petrova@gmail.com' };
const ANNA_W: MailAddress = { name: 'Anna Petrova', address: 'anna@northwind.example' };

const p = (name: string, address: string): MailAddress => ({ name, address });

const SENDERS: MailAddress[] = [
  p('Игорь Смирнов', 'igor@northwind.example'),
  p('Maria Gonzalez', 'maria@lumen.example'),
  p('Ольга Кузнецова', 'olga.k@yandex.ru'),
  p('GitHub', 'noreply@github.com'),
  p('Дмитрий Волков', 'd.volkov@northwind.example'),
  p('Sarah Chen', 'sarah.chen@acme.example'),
  p('Сбербанк', 'info@notify.bank.example'),
  p('Alex Johnson', 'alex@studio.example'),
  p('Екатерина Морозова', 'kate.m@mail.ru'),
  p('Linear', 'notifications@linear.example'),
  p('Павел Орлов', 'pavel@northwind.example'),
  p('Tom Becker', 'tom.becker@berlin.example'),
];

const SUBJECTS: Array<[string, string]> = [
  ['Отчёт за сентябрь', 'Привет! Прикладываю отчёт за сентябрь, посмотри, пожалуйста, до пятницы.'],
  ['Quarterly planning — agenda', 'Hi Anna, here is the draft agenda for next week. Let me know if anything is missing.'],
  ['Встреча в четверг переносится', 'Коллеги, встречу в четверг переносим на 15:00, ссылка та же.'],
  ['[calaba/desktop] PR #412: mail engine skeleton', 'Review requested. 12 files changed, 840 additions, 31 deletions.'],
  ['Счёт № 2026-118', 'Добрый день! Направляем счёт на оплату услуг за октябрь.'],
  ['Design review notes', 'Thanks everyone for the session today. Notes and action items below.'],
  ['Ваша выписка по карте', 'Выписка за период с 01.09 по 30.09 во вложении.'],
  ['Photos from the offsite', 'Uploaded the photos, the best ones are attached here.'],
  ['Билеты на конференцию', 'Билеты куплены, бронь отеля подтверждена. Детали ниже.'],
  ['ENG-2041 moved to In Review', 'Sarah moved ENG-2041 «Mail: discovery chain» to In Review.'],
  ['Договор поставки — правки', 'Посмотрел договор, внёс правки в пункты 4.2 и 7.1, остальное ок.'],
  ['Lunch on Friday?', 'There is a new ramen place near the office, want to try it on Friday?'],
  ['Напоминание: сдать документы', 'Напоминаем, что до 15 октября нужно сдать документы для отпуска.'],
  ['Welcome to the beta', 'Thanks for joining the beta! Here is what is new this week.'],
  ['Вопрос по API', 'Подскажи, пожалуйста, какой лимит на загрузку файлов в API?'],
  ['Re: hiring pipeline', 'Two more candidates for the frontend role, CVs attached.'],
];

const ATTACH: Array<Omit<MailAttachment, 'id'>> = [
  { name: 'Отчёт_сентябрь.pdf', mime: 'application/pdf', size: 482_113, inline: false },
  { name: 'budget-2027.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 91_230, inline: false },
  { name: 'IMG_2041.jpg', mime: 'image/jpeg', size: 2_310_442, inline: false },
  { name: 'Договор_v3.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 154_008, inline: false },
];

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plainHtml(text: string): string {
  return `<div style="font-family:-apple-system,sans-serif;font-size:14px">${text
    .split('\n')
    .map((l) => `<p>${esc(l)}</p>`)
    .join('')}</div>`;
}

function newsletterHtml(): string {
  const sections = Array.from(
    { length: 14 },
    (_, i) =>
      `<tr><td style="padding:24px 32px;border-bottom:1px solid #eee"><h2 style="margin:0 0 8px;font-size:20px;color:#222">${i + 1}. ${
        ['Что нового в продукте', 'Product updates', 'Истории клиентов', 'Tips & tricks', 'Мероприятия'][i % 5] ?? ''
      }</h2><p style="margin:0;color:#555;line-height:1.6">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. Донец эт мэтус ут лорем. Section ${i + 1} of the long newsletter.</p><a href="https://news.example/item/${i + 1}" style="color:#3366ff">Читать дальше →</a></td></tr>`,
  ).join('');
  return `<html><head><style>body{margin:0;background:#f4f4f7}</style></head><body><table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#fff"><tr><td style="padding:32px;background:#1f2937;color:#fff;font-size:28px;font-weight:700">Дайджест недели · Weekly digest</td></tr>${sections}<tr><td style="padding:24px 32px;font-size:12px;color:#999">Вы получили это письмо, потому что подписаны на рассылку. <a href="https://news.example/unsubscribe">Отписаться</a></td></tr></table></body></html>`;
}

/** Builds all mock messages. Pure and deterministic. */
export function mockMessages(): MockMessage[] {
  const out: MockMessage[] = [];
  let seq = 0;
  const msg = (m: Partial<MockMessage> & Pick<MockMessage, 'accountId' | 'folderId' | 'from' | 'subject' | 'date'>): MockMessage => {
    seq++;
    const id = `m${String(seq).padStart(3, '0')}`;
    const text = m.text ?? null;
    const full: MockMessage = {
      threadId: m.threadId ?? `t-${id}`,
      messageIdHeader: `<${id}@mock.calab>`,
      to: m.to ?? [m.accountId === 'acc-gmail' ? ANNA_G : ANNA_W],
      cc: [],
      bcc: [],
      replyTo: [],
      seen: true,
      flagged: false,
      answered: false,
      html: m.html ?? (text ? plainHtml(text) : null),
      text,
      attachments: [],
      inReplyTo: '',
      references: [],
      remoteImages: false,
      ...m,
      id,
    };
    full.attachments = full.attachments.map((a, i) => ({ ...a, id: a.id || `${id}-a${i + 1}` }));
    out.push(full);
    return full;
  };

  // ---- ordinary threads: 48 across the two inboxes, a few archived / junk / trash / custom ----
  for (let i = 0; i < 48; i++) {
    const accountId = i % 3 === 2 ? 'acc-work' : 'acc-gmail';
    const sender = SENDERS[i % SENDERS.length] ?? SENDERS[0];
    const [subject, body] = SUBJECTS[i % SUBJECTS.length] ?? SUBJECTS[0] ?? ['', ''];
    const role = i >= 44 ? (['archive', 'junk', 'trash', 'archive'] as const)[i - 44] : i >= 38 && accountId === 'acc-work' ? 'Проекты' : 'inbox';
    const attachment = i % 7 === 3 ? ATTACH[(i / 7) % ATTACH.length | 0] : undefined;
    msg({
      accountId,
      folderId: folderId(accountId, role ?? 'inbox'),
      from: sender ?? p('', 'unknown@example.com'),
      subject: i >= SUBJECTS.length ? `${subject} (${Math.floor(i / SUBJECTS.length) + 1})` : subject,
      text: `${body}\n\n— ${sender?.name ?? ''}`,
      date: MOCK_NOW - (i * 5 + 2) * H - i * 7 * 60_000,
      seen: i % 4 !== 0,
      flagged: i % 9 === 4,
      attachments: attachment ? [{ ...attachment, id: '' }] : [],
    });
  }

  // ---- a 3-message thread: two in the Gmail inbox, Anna's reply in Sent ----
  const t = 'thread-release';
  const first = msg({
    threadId: t,
    accountId: 'acc-gmail',
    folderId: folderId('acc-gmail', 'inbox'),
    from: p('Игорь Смирнов', 'igor@northwind.example'),
    to: [ANNA_G, p('Дмитрий Волков', 'd.volkov@northwind.example')],
    subject: 'Запуск 3.1: план релиза',
    text: 'Коллеги, предлагаю план релиза 3.1:\n1. Заморозка во вторник\n2. Стенд в среду\n3. Релиз в четверг\nКомментарии?',
    date: MOCK_NOW - 30 * 60_000 - 5 * H,
  });
  const reply = msg({
    threadId: t,
    accountId: 'acc-gmail',
    folderId: folderId('acc-gmail', 'sent'),
    from: ANNA_G,
    to: [p('Игорь Смирнов', 'igor@northwind.example')],
    cc: [p('Дмитрий Волков', 'd.volkov@northwind.example')],
    subject: 'Re: Запуск 3.1: план релиза',
    text: 'Ок по плану, но стенд лучше поднять во вторник вечером.',
    date: MOCK_NOW - 3 * H,
    inReplyTo: first.messageIdHeader,
    references: [first.messageIdHeader],
  });
  msg({
    threadId: t,
    accountId: 'acc-gmail',
    folderId: folderId('acc-gmail', 'inbox'),
    from: p('Дмитрий Волков', 'd.volkov@northwind.example'),
    to: [ANNA_G],
    cc: [p('Игорь Смирнов', 'igor@northwind.example')],
    subject: 'Re: Запуск 3.1: план релиза',
    text: 'Согласен с Анной, стенд во вторник вечером. Я подготовлю чек-лист.',
    date: MOCK_NOW - 25 * 60_000,
    seen: false,
    flagged: true,
    inReplyTo: reply.messageIdHeader,
    references: [first.messageIdHeader, reply.messageIdHeader],
  });

  // ---- an inline cid: image ----
  msg({
    accountId: 'acc-work',
    folderId: folderId('acc-work', 'inbox'),
    from: p('Maria Gonzalez', 'maria@lumen.example'),
    subject: 'New logo — final version',
    html: '<p>Hi Anna,</p><p>Here is the final logo:</p><p><img src="cid:logo@lumen" alt="logo" width="120"></p><p>Best, Maria</p>',
    text: 'Hi Anna,\n\nHere is the final logo (inline image).\n\nBest, Maria',
    date: MOCK_NOW - 50 * 60_000,
    seen: false,
    attachments: [{ id: '', name: 'logo.png', mime: 'image/png', size: 18_220, cid: 'logo@lumen', inline: true }],
  });

  // ---- a remote tracking pixel ----
  msg({
    accountId: 'acc-gmail',
    folderId: folderId('acc-gmail', 'inbox'),
    from: p('Market Weekly', 'news@market.example'),
    subject: 'Скидки недели: −30% на всё',
    html: '<p>Только до воскресенья — скидка 30% на весь каталог.</p><p><a href="https://market.example/sale">Смотреть</a></p><img src="https://track.market.example/open.gif?u=8f2c" width="1" height="1" alt="">',
    text: 'Только до воскресенья — скидка 30% на весь каталог.',
    date: MOCK_NOW - 7 * H,
    seen: false,
    remoteImages: true,
  });

  // ---- a long HTML newsletter (with remote images) ----
  msg({
    accountId: 'acc-gmail',
    folderId: folderId('acc-gmail', 'inbox'),
    from: p('Calab Digest', 'digest@news.example'),
    subject: 'Дайджест недели: 14 историй',
    html: newsletterHtml().replace('</td></tr>', '<img src="https://news.example/hero.jpg" width="576" alt=""></td></tr>'),
    text: 'Дайджест недели. Откройте HTML-версию письма.',
    date: MOCK_NOW - 26 * H,
    remoteImages: true,
  });

  // ---- several attachments in one message ----
  msg({
    accountId: 'acc-work',
    folderId: folderId('acc-work', 'inbox'),
    from: p('Екатерина Морозова', 'kate.m@mail.ru'),
    subject: 'Документы для визы',
    text: 'Анна, добрый день! Отправляю сканы документов: паспорт, справку с работы и фото.',
    date: MOCK_NOW - 9 * H,
    flagged: true,
    attachments: [
      { id: '', name: 'passport.pdf', mime: 'application/pdf', size: 1_204_331, inline: false },
      { id: '', name: 'spravka.pdf', mime: 'application/pdf', size: 310_920, inline: false },
      { id: '', name: 'photo.jpg', mime: 'image/jpeg', size: 820_114, inline: false },
    ],
  });

  // ---- Sent mail of both accounts ----
  for (let i = 0; i < 8; i++) {
    const accountId = i % 2 ? 'acc-work' : 'acc-gmail';
    const to = SENDERS[(i * 5 + 1) % SENDERS.length] ?? SENDERS[0];
    const [subject, body] = SUBJECTS[(i * 3 + 2) % SUBJECTS.length] ?? ['', ''];
    msg({
      accountId,
      folderId: folderId(accountId, 'sent'),
      from: accountId === 'acc-gmail' ? ANNA_G : ANNA_W,
      to: to ? [to] : [],
      subject: `Re: ${subject}`,
      text: `Спасибо! ${body}`,
      date: MOCK_NOW - (i * 11 + 4) * H,
    });
  }
  return out;
}

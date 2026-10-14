import type { PersonKey, Short } from './copy';

/**
 * Landing 3.3 scenes (landing-v5.spec.ts, landing-mail.spec.ts): the data of the new screens in each
 * language — the mailbox of the desktop mail client, the task history, the notification bots and the
 * unified search. Only data lives here; the UI text comes from the app's own dictionaries. People
 * and tasks are those of copy.ts (by key / index).
 */

/** A letter of the mailbox: `ago` = minutes before the scene's «now» (15 Jan 2026, 13:30 MSK). */
export interface Letter {
  from: [string, string];
  subject: string;
  text: string;
  ago: number;
  unread?: boolean;
  flagged?: boolean;
  /** Attachment file names (PDF / XLSX / PNG by extension). */
  files?: string[];
  /** The work account (default) or the personal one. */
  personal?: boolean;
}

export interface Copy3 {
  mail: {
    work: { name: string; email: string };
    personal: { email: string };
    /** Custom folders of the work account. */
    folders: [string, string];
    /** The inbox, newest first; the first one is the opened letter. */
    letters: Letter[];
  };
  /** The task history (the board's opened task): texts of the timeline rows. */
  history: {
    /** The earlier description (the diff's «before»). */
    oldDescription: string;
    approval: string;
    comment: [PersonKey, string];
  };
  /** «Передавать боту»: the relay bot (on) and a second bot (off). */
  bots: { relay: string; other: string };
  /** ⌘K: the query and the snippets of each section; «\u0002…\u0003» marks the matched words. */
  search: { q: string; messages: [PersonKey, string][]; comment: string; file: string; note: string; transcript: string };
}

const mark = (s: string): string => s.replace(/\[/g, '\u0002').replace(/\]/g, '\u0003');

const ru: Copy3 = {
  mail: {
    work: { name: 'Анна Смирнова', email: 'anna@nordlight.ru' },
    personal: { email: 'anna.smirnova@gmail.com' },
    folders: ['Партнёры', 'Бухгалтерия'],
    letters: [
      {
        from: ['Олег Васильев', 'oleg@severstroy.ru'],
        subject: 'Договор на внедрение Calab — финальная версия',
        text: 'Анна, добрый день!\n\nПрикладываю финальную версию договора на внедрение: учли ваши правки в пунктах 3.2 и 5.4, срок запуска — 2 февраля.\n\nЕсли всё в порядке, подпишем в понедельник. Удобно созвониться завтра в 11:00?\n\nС уважением,\nОлег Васильев\nООО «Северстрой»',
        ago: 18,
        unread: true,
        flagged: true,
        files: ['Договор_Нордлайт_v4.pdf', 'Смета_внедрения.xlsx'],
      },
      { from: ['Борис Петров', 'boris@nordlight.ru'], subject: 'Re: Эхо в звонке при колонках', text: 'Фикс эхоподавления уже на стенде, проверил на Windows 11 — чисто. Можно закрывать.', ago: 42, unread: true },
      { from: ['GitHub', 'noreply@github.com'], subject: '[nordlight/app] PR #418: Напоминания о сроке задачи', text: 'Борис Петров запросил ваше ревью: 14 файлов, +620 −84.', ago: 75 },
      { from: ['Вера Ким', 'vera@nordlight.ru'], subject: 'Скриншоты для лендинга — черновик', text: 'Собрала первые восемь экранов, посмотри, пожалуйста, до вечера.', ago: 130, files: ['landing-shots.png'] },
      { from: ['Мария Белова', 'm.belova@buhexpert.ru'], subject: 'Акт сверки за декабрь', text: 'Направляем акт сверки за декабрь, просим подписать до 20 января.', ago: 190, files: ['Акт_сверки_декабрь.pdf'] },
      { from: ['Конференция TeamConf', 'hello@teamconf.example'], subject: 'Ваш доклад принят в программу', text: 'Поздравляем! Доклад «Голос вместо созвонов» включён в программу 12 марта.', ago: 260, flagged: true },
      { from: ['Григорий Соколов', 'grigory@nordlight.ru'], subject: 'Отпуск: кто подменяет', text: 'С 19 по 26 января меня подменяет Дина, доступы ей выдал.', ago: 330 },
      { from: ['Яндекс 360', 'noreply@360.yandex.ru'], subject: 'Счёт за январь оплачен', text: 'Спасибо! Оплата по счёту № 2026-01-118 получена.', ago: 480, personal: true },
      { from: ['Дина Лебедева', 'dina@nordlight.ru'], subject: 'Чек-лист регресса 1.1', text: 'Обновила чек-лист: добавила проверки звонка на трёх ОС.', ago: 1260 },
      { from: ['Ольга Кузнецова', 'olga.k@yandex.ru'], subject: 'Встреча выпускников в субботу', text: 'Собираемся в субботу в 19:00, напиши, придёшь ли.', ago: 1500, personal: true },
    ],
  },
  history: {
    oldDescription: 'Эхо на Windows 11 с колонками.\nШаги — в комментариях.',
    approval: 'Логи чистые, можно выкатывать.',
    comment: ['boris', 'Воспроизвёл на стенде: эхо через ~10 секунд после входа.'],
  },
  bots: { relay: 'Уведомления в Telegram', other: 'Деплой' },
  search: {
    q: 'релиз',
    messages: [
      ['boris', mark('Чек-лист к [релизу] 1.1 обновил, осталось два пункта')],
      ['vera', mark('Макет страницы [релиза] готов, ссылка в задаче')],
    ],
    comment: mark('Фикс эхоподавления войдёт в [релиз] 1.1'),
    file: 'Отчёт по релизу 1.1.pdf',
    note: mark('Список того, что показать на демо [релиза]'),
    transcript: mark('…договорились выкатить [релиз] в четверг после регресса…'),
  },
};

const en: Copy3 = {
  mail: {
    work: { name: 'Emma Carter', email: 'emma@northwind.io' },
    personal: { email: 'emma.carter@gmail.com' },
    folders: ['Partners', 'Accounting'],
    letters: [
      {
        from: ['Daniel Brooks', 'daniel@harborworks.com'],
        subject: 'Calab rollout agreement — final version',
        text: 'Hi Emma,\n\nAttached is the final version of the rollout agreement: your edits to sections 3.2 and 5.4 are in, and the go-live date is February 2.\n\nIf everything looks good, we can sign on Monday. Does a call tomorrow at 11:00 work for you?\n\nBest regards,\nDaniel Brooks\nHarbor Works Ltd.',
        ago: 18,
        unread: true,
        flagged: true,
        files: ['Northwind_agreement_v4.pdf', 'Rollout_estimate.xlsx'],
      },
      { from: ['Ben Walker', 'ben@northwind.io'], subject: 'Re: Echo in calls with speakers', text: 'The echo fix is on staging, checked on Windows 11 — clean. We can close it.', ago: 42, unread: true },
      { from: ['GitHub', 'noreply@github.com'], subject: '[northwind/app] PR #418: Due date reminders', text: 'Ben Walker requested your review: 14 files, +620 −84.', ago: 75 },
      { from: ['Olivia Kim', 'olivia@northwind.io'], subject: 'Landing screenshots — draft', text: 'I put together the first eight screens, could you take a look by tonight?', ago: 130, files: ['landing-shots.png'] },
      { from: ['Laura Mitchell', 'laura@ledgerpoint.com'], subject: 'December reconciliation statement', text: 'Please find the December statement attached; we need it signed by January 20.', ago: 190, files: ['Statement_December.pdf'] },
      { from: ['TeamConf', 'hello@teamconf.example'], subject: 'Your talk has been accepted', text: 'Congratulations! “Voice instead of meetings” is in the program on March 12.', ago: 260, flagged: true },
      { from: ['Greg Foster', 'greg@northwind.io'], subject: 'Vacation: who covers for me', text: 'Dana covers for me January 19–26, she already has the access she needs.', ago: 330 },
      { from: ['Google Workspace', 'billing@google.example'], subject: 'Your January invoice is paid', text: 'Thank you! Payment for invoice 2026-01-118 was received.', ago: 480, personal: true },
      { from: ['Dana Lee', 'dana@northwind.io'], subject: '1.1 regression checklist', text: 'Updated the checklist: added call checks on three operating systems.', ago: 1260 },
      { from: ['Sarah Chen', 'sarah.chen@gmail.com'], subject: 'Reunion on Saturday', text: 'We are meeting on Saturday at 7 pm, let me know if you can make it.', ago: 1500, personal: true },
    ],
  },
  history: {
    oldDescription: 'Echo on Windows 11 with speakers.\nSteps are in the comments.',
    approval: 'Logs are clean, good to ship.',
    comment: ['boris', 'Reproduced on staging: echo about 10 seconds after joining.'],
  },
  bots: { relay: 'Telegram notifications', other: 'Deploy' },
  search: {
    q: 'release',
    messages: [
      ['boris', mark('Updated the [release] 1.1 checklist, two items left')],
      ['vera', mark('The [release] page mockup is ready, link in the task')],
    ],
    comment: mark('The echo fix goes into [release] 1.1'),
    file: 'Release 1.1 report.pdf',
    note: mark('What to show at the [release] demo'),
    transcript: mark('…we agreed to ship the [release] on Thursday after the regression run…'),
  },
};

const es: Copy3 = {
  mail: {
    work: { name: 'Lucía Fernández', email: 'lucia@brisalabs.es' },
    personal: { email: 'lucia.fernandez@gmail.com' },
    folders: ['Socios', 'Contabilidad'],
    letters: [
      {
        from: ['Andrés Navarro', 'andres@costanorte.es'],
        subject: 'Contrato de implantación de Calab — versión final',
        text: 'Hola, Lucía:\n\nAdjunto la versión final del contrato de implantación: incluimos tus cambios en los puntos 3.2 y 5.4, y la puesta en marcha es el 2 de febrero.\n\nSi todo está bien, lo firmamos el lunes. ¿Te va bien una llamada mañana a las 11:00?\n\nUn saludo,\nAndrés Navarro\nCosta Norte S. L.',
        ago: 18,
        unread: true,
        flagged: true,
        files: ['Contrato_Brisa_v4.pdf', 'Presupuesto_implantacion.xlsx'],
      },
      { from: ['Javier Morales', 'javier@brisalabs.es'], subject: 'Re: Eco en llamadas con altavoces', text: 'El arreglo del eco ya está en pruebas, comprobado en Windows 11: limpio. Podemos cerrarla.', ago: 42, unread: true },
      { from: ['GitHub', 'noreply@github.com'], subject: '[brisalabs/app] PR #418: Recordatorios de fecha límite', text: 'Javier Morales ha pedido tu revisión: 14 archivos, +620 −84.', ago: 75 },
      { from: ['Valeria Ruiz', 'valeria@brisalabs.es'], subject: 'Capturas para la web — borrador', text: 'He reunido las primeras ocho pantallas, ¿puedes revisarlas antes de esta noche?', ago: 130, files: ['capturas-web.png'] },
      { from: ['Marta Gil', 'marta@asesoriagil.es'], subject: 'Conciliación de diciembre', text: 'Te enviamos la conciliación de diciembre; necesitamos la firma antes del 20 de enero.', ago: 190, files: ['Conciliacion_diciembre.pdf'] },
      { from: ['TeamConf', 'hello@teamconf.example'], subject: 'Tu charla ha sido aceptada', text: '¡Enhorabuena! «Voz en lugar de reuniones» entra en el programa del 12 de marzo.', ago: 260, flagged: true },
      { from: ['Gonzalo Herrera', 'gonzalo@brisalabs.es'], subject: 'Vacaciones: quién me cubre', text: 'Del 19 al 26 de enero me cubre Daniela, ya tiene los accesos.', ago: 330 },
      { from: ['Google Workspace', 'billing@google.example'], subject: 'Factura de enero pagada', text: '¡Gracias! Hemos recibido el pago de la factura 2026-01-118.', ago: 480, personal: true },
      { from: ['Daniela Castro', 'daniela@brisalabs.es'], subject: 'Lista de regresión 1.1', text: 'He actualizado la lista: añadí pruebas de llamada en tres sistemas.', ago: 1260 },
      { from: ['Carmen López', 'carmen.lopez@gmail.com'], subject: 'Cena de antiguos alumnos el sábado', text: 'Quedamos el sábado a las 19:00, dime si vienes.', ago: 1500, personal: true },
    ],
  },
  history: {
    oldDescription: 'Eco en Windows 11 con altavoces.\nLos pasos están en los comentarios.',
    approval: 'Los registros están limpios, se puede publicar.',
    comment: ['boris', 'Reproducido en pruebas: eco unos 10 segundos después de entrar.'],
  },
  bots: { relay: 'Avisos a Telegram', other: 'Despliegue' },
  search: {
    q: 'versión',
    messages: [
      ['boris', mark('He actualizado la lista de la [versión] 1.1, quedan dos puntos')],
      ['vera', mark('La maqueta de la página de la [versión] está lista, enlace en la tarea')],
    ],
    comment: mark('El arreglo del eco entra en la [versión] 1.1'),
    file: 'Informe de la versión 1.1.pdf',
    note: mark('Qué enseñar en la demo de la [versión]'),
    transcript: mark('…acordamos publicar la [versión] el jueves después de la regresión…'),
  },
};

const zh: Copy3 = {
  mail: {
    work: { name: '林晓雯', email: 'xiaowen@xinghe.cn' },
    personal: { email: 'lin.xiaowen@qq.com' },
    folders: ['合作伙伴', '财务'],
    letters: [
      {
        from: ['赵明', 'zhaoming@huayu-tech.cn'],
        subject: 'Calab 部署合同 — 最终版',
        text: '晓雯您好：\n\n附件是部署合同的最终版：已按您的意见修改第 3.2 条和第 5.4 条，上线日期为 2 月 2 日。\n\n如无问题，我们周一签署。明天上午 11:00 方便通个电话吗？\n\n此致\n赵明\n华宇科技有限公司',
        ago: 18,
        unread: true,
        flagged: true,
        files: ['星河_合同_v4.pdf', '部署预算.xlsx'],
      },
      { from: ['王磊', 'wanglei@xinghe.cn'], subject: '回复：外放音箱通话回声', text: '回声修复已部署到测试环境，在 Windows 11 上验证过，没有问题，可以关闭了。', ago: 42, unread: true },
      { from: ['GitHub', 'noreply@github.com'], subject: '[xinghe/app] PR #418：截止日期提醒', text: '王磊请求你评审：14 个文件，+620 −84。', ago: 75 },
      { from: ['陈思琪', 'siqi@xinghe.cn'], subject: '官网截图 — 草稿', text: '前八个界面已整理好，今晚前帮忙看一下。', ago: 130, files: ['官网截图.png'] },
      { from: ['周芳', 'zhoufang@caiwu-partners.cn'], subject: '12 月对账单', text: '附上 12 月对账单，请于 1 月 20 日前签字。', ago: 190, files: ['12月对账单.pdf'] },
      { from: ['TeamConf', 'hello@teamconf.example'], subject: '你的演讲已入选', text: '恭喜！《用语音代替会议》已列入 3 月 12 日的议程。', ago: 260, flagged: true },
      { from: ['张伟', 'zhangwei@xinghe.cn'], subject: '休假期间由谁代班', text: '1 月 19 日至 26 日由刘丹代班，权限已经开好。', ago: 330 },
      { from: ['腾讯企业邮', 'billing@exmail.example'], subject: '1 月账单已支付', text: '感谢！账单 2026-01-118 已收到付款。', ago: 480, personal: true },
      { from: ['刘丹', 'liudan@xinghe.cn'], subject: '1.1 回归测试清单', text: '清单已更新：增加了三个系统上的通话检查。', ago: 1260 },
      { from: ['李娜', 'lina@qq.com'], subject: '周六同学聚会', text: '周六晚上 7 点聚会，告诉我你来不来。', ago: 1500, personal: true },
    ],
  },
  history: {
    oldDescription: 'Windows 11 外放音箱有回声。\n步骤见评论。',
    approval: '日志正常，可以发布。',
    comment: ['boris', '已在测试环境复现：进入约 10 秒后出现回声。'],
  },
  bots: { relay: 'Telegram 通知', other: '部署' },
  search: {
    q: '发布',
    messages: [
      ['boris', mark('1.1 [发布]清单已更新，还剩两项')],
      ['vera', mark('[发布]页面设计稿已完成，链接在任务里')],
    ],
    comment: mark('回声修复将随 1.1 [发布]'),
    file: '1.1 发布报告.pdf',
    note: mark('[发布]演示要展示的内容'),
    transcript: mark('……约定回归测试后周四[发布]……'),
  },
};

export const COPY3: Record<Short, Copy3> = { ru, en, es, zh };

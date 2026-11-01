import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { Container } from '@/components/ui';
import { getDict, hreflangAlternates, isLocale, localePath, type Locale } from '@/i18n';

type Params = Promise<{ locale: string }>;

const PAGE = 'account-deletion/';
const SUPPORT = 'support@calab.io';

/**
 * /<locale>/account-deletion/ (ADR-0153): the public «how to delete your account» page that
 * Google Play's Data safety form links to — the in-app path, what is deleted and what stays, and
 * the email fallback. Not a legal document (the privacy policy carries the binding wording).
 */
type Copy = {
  title: string;
  description: string;
  appTitle: string;
  steps: string[];
  appNote: string;
  ownerNote: string;
  goneTitle: string;
  gone: string[];
  staysTitle: string;
  stays: string[];
  emailTitle: string;
  email: string;
  subject: string;
};

const COPY: Record<Locale, Copy> = {
  ru: {
    title: 'Удаление аккаунта Calab',
    description: 'Как удалить аккаунт Calab в приложении или по почте и что происходит с данными.',
    appTitle: 'В приложении',
    steps: ['Откройте Calab (компьютер, браузер или телефон) и войдите в аккаунт.', 'Настройки → Профиль → «Удаление аккаунта» → «Удалить…».', 'Введите текущий пароль и нажмите «Удалить навсегда».'],
    appNote: 'Аккаунт удаляется сразу, восстановить его нельзя.',
    ownerNote: 'Если вы владелец пространства, сначала удалите его (настройки пространства) или попросите поддержку передать владение.',
    goneTitle: 'Что удаляется',
    gone: [
      'Профиль: имя, адрес почты, пароль, аватар, ник, телефон, день рождения, настройки.',
      'Вход на всех устройствах и токены уведомлений.',
      'Личные заметки, заметки о людях, подключённый календарь, доступ сторонних приложений, привязки корпоративного входа.',
      'Из резервных копий данные исчезают в течение 30 дней.',
    ],
    staysTitle: 'Что остаётся',
    stays: [
      'Сообщения, задачи и файлы, которые вы оставили в пространствах и личных переписках, — у их участников, с автором «Удалённый пользователь».',
      'Платёжные документы пространств — столько, сколько требует закон.',
    ],
    emailTitle: 'Без приложения',
    email: 'Напишите на {email} с адреса аккаунта, тема «Удаление аккаунта». Мы удалим аккаунт в течение 30 дней и ответим на письмо.',
    subject: 'Удаление аккаунта',
  },
  en: {
    title: 'Delete your Calab account',
    description: 'How to delete your Calab account in the app or by email, and what happens to your data.',
    appTitle: 'In the app',
    steps: ['Open Calab (desktop, browser or phone) and sign in.', 'Settings → Profile → “Delete account” → “Delete…”.', 'Enter your current password and press “Delete for good”.'],
    appNote: 'The account is deleted immediately and cannot be restored.',
    ownerNote: 'If you own a workspace, delete it first (workspace settings) or ask support to hand ownership over.',
    goneTitle: 'What is deleted',
    gone: [
      'Your profile: name, email address, password, avatar, username, phone, birthday, settings.',
      'Sign-ins on every device and notification tokens.',
      'Personal notes, notes about people, the connected calendar, third-party app access, corporate sign-in links.',
      'Backups drop the data within 30 days.',
    ],
    staysTitle: 'What stays',
    stays: [
      'Messages, tasks and files you left in workspaces and direct messages stay with their members, shown as “Deleted user”.',
      'Workspace payment records, for as long as the law requires.',
    ],
    emailTitle: 'Without the app',
    email: 'Write to {email} from the account’s address with the subject “Delete my account”. We delete the account within 30 days and reply to your email.',
    subject: 'Delete my account',
  },
  es: {
    title: 'Eliminar tu cuenta de Calab',
    description: 'Cómo eliminar tu cuenta de Calab en la aplicación o por correo y qué pasa con tus datos.',
    appTitle: 'En la aplicación',
    steps: ['Abre Calab (escritorio, navegador o teléfono) e inicia sesión.', 'Configuración → Perfil → «Eliminar cuenta» → «Eliminar…».', 'Introduce tu contraseña actual y pulsa «Eliminar para siempre».'],
    appNote: 'La cuenta se elimina de inmediato y no se puede recuperar.',
    ownerNote: 'Si eres propietario de un espacio de trabajo, elimínalo primero (configuración del espacio) o pide a soporte que transfiera la propiedad.',
    goneTitle: 'Qué se elimina',
    gone: [
      'Tu perfil: nombre, correo, contraseña, avatar, usuario, teléfono, cumpleaños, configuración.',
      'Las sesiones en todos los dispositivos y los tokens de notificaciones.',
      'Notas personales, notas sobre personas, el calendario conectado, el acceso de aplicaciones de terceros, los vínculos de inicio de sesión corporativo.',
      'Las copias de seguridad eliminan los datos en un plazo de 30 días.',
    ],
    staysTitle: 'Qué se conserva',
    stays: [
      'Los mensajes, tareas y archivos que dejaste en espacios de trabajo y mensajes directos se quedan con sus miembros, como «Usuario eliminado».',
      'Los registros de pago de los espacios de trabajo, durante el tiempo que exija la ley.',
    ],
    emailTitle: 'Sin la aplicación',
    email: 'Escribe a {email} desde la dirección de la cuenta con el asunto «Eliminar mi cuenta». Eliminamos la cuenta en un plazo de 30 días y respondemos a tu correo.',
    subject: 'Eliminar mi cuenta',
  },
  zh: {
    title: '删除你的 Calab 账号',
    description: '如何在应用中或通过邮件删除 Calab 账号，以及你的数据会如何处理。',
    appTitle: '在应用中',
    steps: ['打开 Calab（桌面、浏览器或手机）并登录。', '设置 → 个人资料 → “删除账号” → “删除…”。', '输入当前密码并点击“永久删除”。'],
    appNote: '账号将立即删除，无法恢复。',
    ownerNote: '如果你是工作区的所有者，请先删除该工作区（工作区设置），或请支持团队转交所有权。',
    goneTitle: '将被删除',
    gone: [
      '个人资料：姓名、邮箱地址、密码、头像、用户名、电话、生日、设置。',
      '所有设备上的登录和通知令牌。',
      '个人笔记、关于他人的备注、已连接的日历、第三方应用授权、企业登录关联。',
      '备份中的数据会在 30 天内清除。',
    ],
    staysTitle: '将保留',
    stays: [
      '你在工作区和私信中留下的消息、任务和文件会保留给其成员，作者显示为“已删除的用户”。',
      '工作区的付款记录，按法律要求的期限保存。',
    ],
    emailTitle: '不使用应用',
    email: '请用账号邮箱写信至 {email}，主题为“删除我的账号”。我们会在 30 天内删除账号并回复你的邮件。',
    subject: '删除我的账号',
  },
};

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const { title, description } = COPY[locale];
  return {
    title: `${title} — Calab`,
    description,
    alternates: { canonical: localePath(locale, PAGE), languages: hreflangAlternates(PAGE) },
    openGraph: { title, description, url: localePath(locale, PAGE) },
  };
}

export default async function AccountDeletionPage({ params }: { params: Params }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale);
  const c = COPY[locale];
  const [before, after] = c.email.split('{email}');
  const mailto = `mailto:${SUPPORT}?subject=${encodeURIComponent(c.subject)}`;
  return (
    <>
      <Header t={t.header} locale={locale} page={PAGE} />
      <main id="main" className="py-12 sm:py-20">
        <Container>
          <article className="mx-auto max-w-[720px] break-words" aria-labelledby="deletion-title">
            <h1 id="deletion-title" className="text-[32px] leading-tight font-semibold tracking-tight sm:text-[44px]">{c.title}</h1>
            <p className="mt-4 text-[17px] leading-7 text-fg-2">{c.description}</p>
            <section className="mt-10" aria-labelledby="deletion-app">
              <h2 id="deletion-app" className="mb-4 text-[21px] leading-8 font-semibold">{c.appTitle}</h2>
              <ol className="list-decimal space-y-2 pl-6 text-[16px] leading-7">
                {c.steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
              <p className="mt-4 text-[16px] leading-7">{c.appNote}</p>
              <p className="mt-2 text-[16px] leading-7 text-fg-2">{c.ownerNote}</p>
            </section>
            <section className="mt-10" aria-labelledby="deletion-gone">
              <h2 id="deletion-gone" className="mb-4 text-[21px] leading-8 font-semibold">{c.goneTitle}</h2>
              <ul className="list-disc space-y-2 pl-6 text-[16px] leading-7">
                {c.gone.map((s) => <li key={s}>{s}</li>)}
              </ul>
            </section>
            <section className="mt-10" aria-labelledby="deletion-stays">
              <h2 id="deletion-stays" className="mb-4 text-[21px] leading-8 font-semibold">{c.staysTitle}</h2>
              <ul className="list-disc space-y-2 pl-6 text-[16px] leading-7">
                {c.stays.map((s) => <li key={s}>{s}</li>)}
              </ul>
            </section>
            <section className="mt-10" aria-labelledby="deletion-email">
              <h2 id="deletion-email" className="mb-4 text-[21px] leading-8 font-semibold">{c.emailTitle}</h2>
              <p className="text-[16px] leading-7">
                {before}
                <a className="link" href={mailto}>{SUPPORT}</a>
                {after}
              </p>
            </section>
          </article>
        </Container>
      </main>
      <Footer t={t.footer} locale={locale} />
    </>
  );
}

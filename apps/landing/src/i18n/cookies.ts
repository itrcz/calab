import type { Locale } from './locales';

type CookieCopy = {
  title: string; body: string; allow: string; reject: string; settings: string;
  save: string; close: string; policy: string; necessary: string; necessaryDetail: string;
  language: string; languageDetail: string; analytics: string; marketing: string;
  inactive: string; future: string; error: string;
};

export const COOKIE_COPY: Record<Locale, CookieCopy> = {
  ru: {
    title: 'Cookies и настройки',
    body: 'Вы решаете, запоминать ли язык сайта. Необходимая запись сохраняет ваш выбор на 180 дней. Аналитика и реклама пока не подключены.',
    allow: 'Разрешить необязательные', reject: 'Только необходимые', settings: 'Настроить',
    save: 'Сохранить выбор', close: 'Закрыть без изменения выбора', policy: 'Политика cookies',
    necessary: 'Необходимые · всегда включены', necessaryDetail: 'Хранят ваш выбор, чтобы соблюдать разрешение или отказ.',
    language: 'Предпочтения', languageDetail: 'Запоминать выбранный язык при следующем посещении.',
    analytics: 'Аналитика', marketing: 'Маркетинг', inactive: 'Не подключено',
    future: 'Когда добавим такие сервисы, укажем их здесь и запросим согласие заново. До согласия они не будут загружаться.',
    error: 'Браузер не позволил сохранить выбор. Необязательное хранение выключено; ссылки выбора языка работают.',
  },
  en: {
    title: 'Cookies & preferences',
    body: 'Choose whether this site remembers your language. A necessary record saves your choice for 180 days. Analytics and advertising are not connected yet.',
    allow: 'Allow optional', reject: 'Necessary only', settings: 'Customise',
    save: 'Save choices', close: 'Close without changing choices', policy: 'Cookie policy',
    necessary: 'Necessary · always on', necessaryDetail: 'Remember your choice so we can honour permission or refusal.',
    language: 'Preferences', languageDetail: 'Remember your chosen language on your next visit.',
    analytics: 'Analytics', marketing: 'Marketing', inactive: 'Not connected',
    future: 'When we add these services, we will list them here and ask again. They will not load before permission.',
    error: 'Your browser could not save this choice. Optional storage stays off; language links still work.',
  },
  es: {
    title: 'Cookies y preferencias',
    body: 'Tú decides si recordamos el idioma. Un registro necesario guarda tu elección durante 180 días. Aún no hay analítica ni publicidad conectadas.',
    allow: 'Permitir opcionales', reject: 'Solo necesarias', settings: 'Personalizar',
    save: 'Guardar selección', close: 'Cerrar sin cambiar la selección', policy: 'Política de cookies (EN)',
    necessary: 'Necesarias · siempre activas', necessaryDetail: 'Guardan tu elección para respetar tu permiso o rechazo.',
    language: 'Preferencias', languageDetail: 'Recordar el idioma elegido en tu próxima visita.',
    analytics: 'Analítica', marketing: 'Marketing', inactive: 'Sin conectar',
    future: 'Al añadir estos servicios, los indicaremos aquí y pediremos permiso de nuevo. No se cargarán antes del consentimiento.',
    error: 'El navegador no pudo guardar tu elección. El almacenamiento opcional sigue desactivado; los enlaces de idioma funcionan.',
  },
  zh: {
    title: 'Cookie 与偏好设置',
    body: '由你决定是否记住网站语言。必要记录会保存你的选择 180 天。目前尚未接入分析或广告服务。',
    allow: '允许可选存储', reject: '仅必要存储', settings: '自定义',
    save: '保存选择', close: '关闭且不更改选择', policy: 'Cookie 政策（英语）',
    necessary: '必要存储 · 始终启用', necessaryDetail: '记录你的选择，以尊重允许或拒绝的决定。',
    language: '偏好设置', languageDetail: '下次访问时记住你选择的语言。',
    analytics: '分析', marketing: '营销', inactive: '尚未接入',
    future: '接入这些服务时，我们会在这里列出并重新征求同意。获得同意前不会加载。',
    error: '浏览器无法保存选择。可选存储保持关闭，语言切换链接仍然可用。',
  },
};

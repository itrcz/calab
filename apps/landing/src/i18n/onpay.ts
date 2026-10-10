import type { Locale } from './locales';

// Return pages of the payment form (/onpay/success/, /onpay/fail/): fixed URLs without a language segment,
// so the page picks its language in the browser. Static text only — nothing from the query string is shown.
export type OnpayCopy = {
  title: string;
  text: string;
  web: string;
  app: string;
  support: string;
  supportLink: string;
  home: string;
};

export const ONPAY_COPY: Record<'success' | 'fail', Record<Locale, OnpayCopy>> = {
  success: {
    ru: {
      title: 'Оплата прошла',
      text: 'Деньги появятся на балансе пространства в течение минуты — тариф подключится сам. Окно можно закрыть.',
      web: 'Открыть Calab в браузере',
      app: 'Открыть приложение',
      support: 'Не появились деньги или нужен чек?',
      supportLink: 'Напишите нам',
      home: 'На главную',
    },
    en: {
      title: 'Payment received',
      text: 'The money will appear on your workspace balance within a minute, and the plan switches on by itself. You can close this window.',
      web: 'Open Calab in the browser',
      app: 'Open the app',
      support: 'Balance did not change or need a receipt?',
      supportLink: 'Write to us',
      home: 'Home',
    },
    es: {
      title: 'Pago recibido',
      text: 'El dinero aparecerá en el saldo del espacio en menos de un minuto y el plan se activará solo. Puedes cerrar esta ventana.',
      web: 'Abrir Calab en el navegador',
      app: 'Abrir la aplicación',
      support: '¿El saldo no cambió o necesitas un recibo?',
      supportLink: 'Escríbenos',
      home: 'Inicio',
    },
    zh: {
      title: '支付成功',
      text: '款项将在一分钟内入账到工作区余额，套餐会自动开通。您可以关闭此窗口。',
      web: '在浏览器中打开 Calab',
      app: '打开应用',
      support: '余额没有变化，或需要收据？',
      supportLink: '联系我们',
      home: '返回首页',
    },
  },
  fail: {
    ru: {
      title: 'Оплата не прошла',
      text: 'Деньги не списаны. Попробуйте ещё раз: в Calab откройте «Тариф и оплата» и повторите оплату.',
      web: 'Открыть Calab в браузере',
      app: 'Открыть приложение',
      support: 'Не получается оплатить?',
      supportLink: 'Напишите нам',
      home: 'На главную',
    },
    en: {
      title: 'Payment failed',
      text: 'Nothing was charged. Try again: in Calab open “Plan and billing” and repeat the payment.',
      web: 'Open Calab in the browser',
      app: 'Open the app',
      support: 'Cannot pay?',
      supportLink: 'Write to us',
      home: 'Home',
    },
    es: {
      title: 'El pago no se completó',
      text: 'No se ha cobrado nada. Inténtalo de nuevo: en Calab abre «Plan y pagos» y repite el pago.',
      web: 'Abrir Calab en el navegador',
      app: 'Abrir la aplicación',
      support: '¿No consigues pagar?',
      supportLink: 'Escríbenos',
      home: 'Inicio',
    },
    zh: {
      title: '支付未完成',
      text: '未扣款。请重试：在 Calab 中打开“套餐与付费”，再次支付。',
      web: '在浏览器中打开 Calab',
      app: '打开应用',
      support: '无法支付？',
      supportLink: '联系我们',
      home: '返回首页',
    },
  },
};

import {
  DEFAULT_MAIL_SETTINGS,
  MailApiError,
  isMailError,
  isMailMethod,
  mailMethods,
  type MailHandlers,
  type MailMethod,
  type MailRequest,
  type MailResponse,
} from '../../shared/mail';
import { classify } from './errors';

const notImplemented = (method: MailMethod) => (): Promise<never> =>
  Promise.reject(new MailApiError({ code: 'NOT_IMPLEMENTED', message: `${method} is not implemented yet` }));

/**
 * A placeholder dispatch table (ADR-0088 §7) for an engine that has not received `init` yet: an
 * empty account list, default settings, a no-op sync, NOT_IMPLEMENTED for the rest. The real table
 * is `MailEngine.handlers()` (service.ts).
 */
export function createHandlers(): MailHandlers {
  const table = Object.fromEntries(mailMethods.map((m) => [m, notImplemented(m)])) as unknown as MailHandlers;
  table['accounts.list'] = () => Promise.resolve([]);
  table['settings.get'] = () => Promise.resolve(structuredClone(DEFAULT_MAIL_SETTINGS));
  table['sync.now'] = () => Promise.resolve();
  return table;
}

/** Runs one request against the table; never throws (errors become `{ ok: false }`). */
export async function dispatch(handlers: MailHandlers, req: MailRequest): Promise<MailResponse> {
  const method: unknown = req.method;
  if (!isMailMethod(method) || !Array.isArray(req.params)) {
    return { id: req.id, ok: false, error: { code: 'INVALID', message: `unknown mail method ${JSON.stringify(method)}` } };
  }
  const fn = handlers[method] as (...args: unknown[]) => Promise<unknown>;
  try {
    const result = await fn(...req.params);
    return { id: req.id, ok: true, result };
  } catch (e) {
    if (e instanceof MailApiError) return { id: req.id, ok: false, error: e.toJSON() };
    if (isMailError(e)) return { id: req.id, ok: false, error: { code: e.code, message: e.message } };
    // Library errors (imapflow, nodemailer, sockets): NETWORK / TLS / AUTH_FAILED / … by shape.
    return { id: req.id, ok: false, error: classify(e) };
  }
}

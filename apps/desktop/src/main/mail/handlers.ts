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

const notImplemented = (method: MailMethod) => (): Promise<never> =>
  Promise.reject(new MailApiError({ code: 'NOT_IMPLEMENTED', message: `${method} is not implemented yet` }));

/**
 * The engine's dispatch table (ADR-0080 §7). T0 skeleton: an empty account list, default settings,
 * a no-op sync; everything else answers NOT_IMPLEMENTED until the engine (T1) fills it in.
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
    return { id: req.id, ok: false, error: { code: 'INVALID', message: e instanceof Error ? e.message : String(e) } };
  }
}

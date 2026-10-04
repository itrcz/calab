import { useEffect, useState, type ReactNode } from 'react';
import type { PublicBoardFormResponse } from '@calaba/protocol';
import { Button, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { boardForms } from '../../services/boardForms';
import { useSession } from '../../stores/session';
import { AuthScreen } from '../auth/AuthScreen';
import { FormFields } from './FormFields';

export function FormPublicPage({ code }: { code: string }): ReactNode {
  const signed = useSession((s) => s.status === 'authed');
  const [form, setForm] = useState<PublicBoardFormResponse>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [changed, setChanged] = useState(false);
  const [login, setLogin] = useState(false);
  const [privateRoute, setPrivateRoute] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [nonce] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex,nofollow';
    document.head.append(robots);
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(referrer);
    return () => {
      robots.remove();
      referrer.remove();
    };
  }, []);
  useEffect(() => {
    let live = true;
    void boardForms
      .get(code, false)
      .then((v) => ({ value: v, privateRoute: false }))
      .catch(async (e: unknown) => {
        if (e instanceof ApiError && e.status === 401 && signed) {
          const v = await boardForms.get(code, true);
          return { value: v, privateRoute: true };
        }
        throw e;
      })
      .then((v) => {
        if (live) {
          setForm(v.value);
          setPrivateRoute(v.privateRoute);
          setError('');
          setNeedLogin(false);
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setForm(undefined);
          setError(t('forms.unavailable'));
          setNeedLogin(e instanceof ApiError && e.status === 401);
        }
      });
    return () => {
      live = false;
    };
  }, [code, signed, reload]);
  if (login && !signed) return <AuthScreen />;
  return (
    <main className="h-full overflow-y-auto bg-bg px-5 py-10 text-fg">
      <div className="mx-auto flex max-w-[640px] flex-col gap-6">
        <p className="text-caption font-medium text-muted">Calab</p>
        {form && (signed || !privateRoute) ? (
          <>
            <h1 className="text-title font-semibold">{form.title}</h1>
            {form.description ? <p className="whitespace-pre-wrap text-body text-muted">{form.description}</p> : null}
            <FormFields
              key={code}
              fields={form.fields}
              submit={async (answers) => {
                try {
                  return await boardForms.submit(code, privateRoute, form.revision, nonce, answers);
                } catch (e) {
                  if (e instanceof ApiError && e.reason === 'FORM_CHANGED') setChanged(true);
                  throw e;
                }
              }}
            />
            {changed ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setReload((v) => v + 1);
                  setChanged(false);
                }}
              >
                {t('forms.retry')}
              </Button>
            ) : null}
          </>
        ) : error ? (
          <>
            <h1 className="text-title">{needLogin ? t('forms.signin') : error}</h1>
            {needLogin ? <Button onClick={() => setLogin(true)}>{t('forms.signin')}</Button> : null}
          </>
        ) : (
          <Spinner />
        )}
      </div>
    </main>
  );
}

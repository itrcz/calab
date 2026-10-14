import { RoomType } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Hash, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Logo } from '../../components/Logo';
import { MediaImg } from '../../components/MediaImg';
import { Button, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api, thumbnailPath } from '../../lib/api/endpoints';
import { bindLaunchSignals, createLaunchProbe, deepLinkFor, launchMethod, type LaunchProbe, type LaunchState } from '../../lib/appLaunch';
import { workspaceInitials } from '../../lib/initials';
import { alwaysOpenInApp, continueInBrowser, setAlwaysOpenInApp, type LinkLanding } from '../../services/linkLanding';
import { useSession } from '../../stores/session';
import { AuthLegalFooter } from '../legal/Legal';
import { roomLinkError } from '../people/roomLink';
import { ApprovalNote } from '../guests/ApprovalNote';

/**
 * Web link page (docs/09 #53): `https://<server>/join/<code>` / `/r/<code>` → a card with the
 * preview and «Открыть в Calab» (fires the internal `calab://` deep link; lib/appLaunch.ts decides
 * «opened» vs «Приложение не найдено» by whether the page lost focus), «Продолжить в браузере»
 * (the regular web flow) and «Скачать приложение» (/download/ on this origin).
 */

/** Fires the deep link without leaving the page (see `launchMethod`). */
function fireDeepLink(url: string): void {
  if (launchMethod(navigator.userAgent) === 'iframe') {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    f.setAttribute('aria-hidden', 'true');
    f.src = url;
    document.body.appendChild(f);
    window.setTimeout(() => f.remove(), 5000);
  } else {
    window.location.href = url;
  }
}

const btn = 'h-9 w-full text-body';

export function LinkLandingScreen({ link }: { link: LinkLanding }): ReactNode {
  const authed = useSession((s) => s.status === 'authed');
  // Visual tests exercise the states without handing a link to the OS.
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const [state, setState] = useState<LaunchState>('idle');
  const [always, setAlways] = useState(alwaysOpenInApp);
  const probe = useRef<LaunchProbe | null>(null);
  const autoTried = useRef(false);

  useEffect(() => {
    const p = createLaunchProbe({ onChange: setState });
    probe.current = p;
    const off = bindLaunchSignals(p);
    return () => {
      off();
      p.dispose();
      probe.current = null;
    };
  }, []);

  const open = (): void => {
    probe.current?.start();
    if (!visualTest) fireDeepLink(deepLinkFor(link.kind, link.code));
  };

  // «Всегда открывать в приложении»: try the app right away (once, StrictMode-safe).
  useEffect(() => {
    if (autoTried.current || !alwaysOpenInApp()) return;
    autoTried.current = true;
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on arrival
  }, []);

  const notFound = state === 'not-found';
  // Whether «всегда в приложении» was on when the app turned out missing: then the box stays so it
  // can be turned off; otherwise it is hidden in that state (it would contradict «не найдено»).
  const [alwaysAtNotFound, setAlwaysAtNotFound] = useState<boolean | null>(null);
  if (notFound && alwaysAtNotFound === null) setAlwaysAtNotFound(always);
  if (!notFound && alwaysAtNotFound !== null) setAlwaysAtNotFound(null);
  const hideAlways = notFound && alwaysAtNotFound === false;

  return (
    <div className="auth-backdrop drag flex h-full flex-col items-center overflow-y-auto px-4 py-10 mobile:pb-[calc(var(--safe-bottom)+24px)] mobile:pt-[calc(var(--safe-top)+16px)]" data-testid="link-landing">
      <main className="no-drag my-auto flex w-full max-w-[400px] flex-col items-stretch">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={56} alt="Calab" />
        </div>
        <div className="mat-popover flex flex-col gap-5 rounded-[var(--radius-panel)] p-6">
          {link.kind === 'r' ? <RoomPreview code={link.code} authed={authed} /> : <WorkspacePreview code={link.code} authed={authed} />}

          <div role="status" aria-live="polite" className={cx('text-center text-body', state === 'idle' && 'sr-only')} data-testid="link-landing-status">
            {state === 'trying' ? (
              <p className="text-muted">
                {t('landing.trying')}{' '}
                <button type="button" className="rounded-[var(--radius-control)] text-accent-text hover:underline" onClick={continueInBrowser}>
                  {t('landing.inBrowser')}
                </button>
              </p>
            ) : state === 'opened' ? (
              <p className="text-muted">{t('landing.opened')}</p>
            ) : notFound ? (
              <>
                <p className="font-semibold">{t('landing.notFound')}</p>
                <p className="mt-0.5 text-muted">{t('landing.notFoundHint')}</p>
              </>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            {notFound ? (
              // The app did not answer: the browser and the download become the obvious ways on.
              // Focus moves to the new primary action (the focused «Открыть» button is gone).
              <>
                <Button autoFocus className={cx(btn, 'font-semibold')} onClick={continueInBrowser}>
                  {t('landing.browser')}
                </Button>
                <a
                  href="/download/"
                  className="inline-flex h-9 w-full items-center justify-center rounded-[var(--radius-control)] mobile:tap-h bg-hover text-body font-medium text-fg transition-[background-color] duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)]"
                >
                  {t('landing.download')}
                </a>
                <Button variant="secondary" className={btn} onClick={open}>
                  {t('landing.retry')}
                </Button>
              </>
            ) : (
              <>
                <Button className={cx(btn, 'font-semibold')} onClick={open}>
                  {t('landing.open')}
                </Button>
                <Button variant="secondary" className={btn} onClick={continueInBrowser}>
                  {t('landing.browser')}
                </Button>
                <a href="/download/" className="mt-1 inline-flex self-center items-center mobile:tap-min-h rounded-[var(--radius-control)] px-1 text-body text-accent-text hover:underline">
                  {t('landing.download')}
                </a>
              </>
            )}
          </div>

          {hideAlways ? null : (
            <label className="flex cursor-default items-center justify-center gap-2 text-body text-muted mobile:min-h-11">
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => {
                setAlways(e.target.checked);
                setAlwaysOpenInApp(e.target.checked);
              }}
              className="size-3.5 accent-[var(--color-accent)] mobile:size-5"
            />
            {t('landing.always')}
            </label>
          )}
        </div>
      </main>
      {/* NOTICE: the «Powered by GPTunneL» attribution is required in the UI (BUSL-1.1 grant). */}
      <AuthLegalFooter className="mobile:mt-6 mobile:shrink-0" />
    </div>
  );
}

/** Workspace icon: the uploaded one needs a session (files are not public), else the initials. */
function WorkspaceGlyph({ name, iconFileId, authed }: { name: string; iconFileId: string; authed: boolean }): ReactNode {
  return (
    <span className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-panel)] bg-accent-strong text-title font-semibold text-accent-fg" aria-hidden>
      {authed && iconFileId ? <MediaImg path={thumbnailPath(iconFileId)} alt="" className="size-full object-cover" /> : workspaceInitials(name)}
    </span>
  );
}

function PreviewSkeleton(): ReactNode {
  return <div className="h-[116px]" aria-hidden />;
}

function Invalid({ text }: { text: string }): ReactNode {
  return (
    <p className="text-center text-body text-danger-text" role="alert">
      {text}
    </p>
  );
}

/**
 * GET /api/invites/{code} is public (ADR-0023): the workspace, its member count and, for an
 * invitation sent by email, the address (the sign-up form then locks it).
 */
function WorkspacePreview({ code, authed }: { code: string; authed: boolean }): ReactNode {
  const q = useQuery({ queryKey: ['invite', code], queryFn: () => api.invites.get(code), retry: false, staleTime: 60_000 });
  if (q.isLoading) return <PreviewSkeleton />;
  const ws = q.data?.workspace;
  const invalid = q.error instanceof ApiError && (q.error.is('ERROR_CODE_INVITE_INVALID') || q.error.status === 404 || q.error.status === 410);
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {ws ? <WorkspaceGlyph name={ws.name} iconFileId={ws.iconFileId} authed={authed} /> : null}
      {ws ? (
        <div className="flex max-w-full flex-col items-center">
          <p className="text-body text-muted">{t('landing.workspaceTitle')}</p>
          <h1 className="mt-1 max-w-full truncate text-title font-semibold" title={ws.name}>
            {ws.name}
          </h1>
          {q.data?.memberCount ? <p className="mt-0.5 text-body text-muted">{plural('mail.landing.members', q.data.memberCount)}</p> : null}
          {q.data?.email ? (
            <p className="mt-0.5 max-w-full truncate text-body text-muted" title={q.data.email}>
              {t('mail.landing.forEmail', { email: q.data.email })}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex max-w-full flex-col items-center">
          <h1 className="text-title font-semibold">{t('landing.workspaceTitle')}</h1>
          <p className="mt-1 text-body text-muted">{t('landing.workspaceGeneric')}</p>
        </div>
      )}
      {invalid ? <Invalid text={t('landing.invalid')} /> : null}
    </div>
  );
}

/** GET /api/room-invites/{code} is public (ADR-0016): room, type and workspace for everyone. */
function RoomPreview({ code, authed }: { code: string; authed: boolean }): ReactNode {
  const q = useQuery({ queryKey: ['roomLink', code], queryFn: () => api.roomInvites.get(code), retry: false, staleTime: 60_000 });
  if (q.isLoading) return <PreviewSkeleton />;
  const p = q.data;
  if (!p) return <Invalid text={roomLinkError(q.error)} />;
  const voice = p.roomType === RoomType.VOICE;
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <WorkspaceGlyph name={p.workspaceName} iconFileId={p.workspaceIconFileId} authed={authed} />
      <div className="flex max-w-full flex-col items-center">
        <p className="text-body text-muted">{t('guest.title')}</p>
        <h1 className="mt-1 flex max-w-full items-center gap-2 text-title font-semibold">
          {voice ? <Volume2 className="size-5 shrink-0 text-muted" aria-label={t('guest.voice')} /> : <Hash className="size-5 shrink-0 text-muted" aria-label={t('guest.text')} />}
          <span className="truncate" title={p.roomName}>
            {p.roomName}
          </span>
        </h1>
        <p className="mt-0.5 max-w-full truncate text-body text-muted" title={p.workspaceName}>
          {t('guest.in', { ws: p.workspaceName })}
        </p>
      </div>
      {p.requiresApproval ? <ApprovalNote compact /> : null}
    </div>
  );
}

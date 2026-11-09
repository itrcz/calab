import { formPageCode } from '../services/boardForms';
import { mailResetToken } from '../services/mailReset';
import { MailResetPage } from '../features/mail/MailResetPage';
import { FormPublicPage } from '../features/boards/FormPublicPage';
import { WikiPublicPage } from '../features/wiki/PublicPage';
import { wikiPageCode } from '../services/wikiPublic';
import { CanvasPublicPage } from '../features/canvas/PublicPage';
import { canvasPageCode } from '../services/canvasPublic';
import { OAuthConsent } from '../features/identity/OAuth';
import { McpConnect } from '../features/mcp/McpConnect';
import { mcpConnectHandle } from '../features/mcp/model';
import { SsoComplete } from '../features/identity/SignIn';
import { consentHandle } from '../features/identity/model';
import * as TooltipP from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '../components/ui';
import { AuthScreen } from '../features/auth/AuthScreen';
import { LinkLandingScreen } from '../features/auth/LinkLanding';
import { OfflineScreen, TooManySessions } from '../features/auth/SessionScreens';
import { AppShell } from '../features/shell/AppShell';
import { Dialogs } from '../features/shell/Dialogs';
import { CallLayer } from '../features/call/CallLayer';
import { Toasts } from '../features/shell/Toasts';
import { KnockToasts } from '../features/guests/KnockToast';
import { WaitingScreen } from '../features/guests/WaitingScreen';
import { useWaiting } from '../features/guests/stores/admissions';
import { useLocale, t, type Locale } from '../i18n';
import { useTimeFormat } from '../lib/format';
import { setVoice } from '../stores/voice';
import { usePrefs } from '../stores/prefs';
import { queryClient } from '../lib/queryClient';
import { platform } from '../platform';
import { useLinkLanding } from '../services/linkLanding';
import { useEventPage } from '../services/eventPage';
import { EventPublicPage } from '../features/calendar/EventPublicPage';
import { logout } from '../services/session';
import { useSession } from '../stores/session';

export { queryClient };

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST): sign out, back to the login screen. */
    __calabaLogout?: () => Promise<void>;
    /** Visual / marketing tests only: switch the UI language live (landing shots per locale). */
    __calabaLocale?: (locale: Locale) => void;
    /** Visual tests only: the room a phone call parked (ADR-0133) — the phone harness has no LiveKit link to park. */
    __calabaParked?: (p: { roomId: string; workspaceId: string } | null) => void;
    /** Visual tests only: be «in voice» in a room by store state alone, no LiveKit (null = leave; `phase` defaults to connected). */
    __calabaVoiceSeat?: (seat: { roomId: string; workspaceId: string; phase?: 'connected' | 'reconnecting' } | null) => void;
  }
}

function useTheme(): void {
  const theme = usePrefs((s) => s.theme);
  const os = useSession((s) => s.appInfo?.platform);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  useEffect(() => {
    // macOS: overlay scrollbars (docs/08).
    const root = document.documentElement;
    root.classList.toggle('mac', os === 'darwin' || /Mac OS X|Macintosh/.test(navigator.userAgent));
    root.classList.toggle('test-stable', visualTest);
    // Visual tests only: sign out without relaunching the app (per-screen tests reset to the login).
    if (!visualTest) return;
    window.__calabaLogout = () => logout();
    window.__calabaLocale = (locale) => usePrefs.getState().setPrefs({ locale });
    window.__calabaParked = (parked) => setVoice({ parked });
    window.__calabaVoiceSeat = (seat) =>
      setVoice(seat ? { roomId: seat.roomId, workspaceId: seat.workspaceId, phase: seat.phase ?? 'connected', joinedAt: Date.now() } : { roomId: null, workspaceId: null, phase: 'idle', joinedAt: null });
    return () => {
      delete window.__calabaLogout;
      delete window.__calabaLocale;
      delete window.__calabaParked;
      delete window.__calabaVoiceSeat;
    };
  }, [os, visualTest]);
  useEffect(() => {
    platform.app.setTheme(theme); // the window background follows the app theme
    const apply = (): void => {
      const dark = theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark';
      document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

export function App(): ReactNode {
  useTheme();
  // A language switch re-renders the tree from here (memo rows subscribe themselves); no reload.
  useLocale();
  // The workspace's clock format (docs/09 #73) likewise.
  useTimeFormat();
  const status = useSession((s) => s.status);
  const tooMany = useSession((s) => s.tooManySessions);
  const landing = useLinkLanding((s) => s.link);
  const eventPage = useEventPage((s) => s.page);
  const formCode = formPageCode();
  const wikiCode = wikiPageCode();
  const canvasCode = canvasPageCode();
  // A guest's knock on a room (ADR-0040): the waiting screen in place of the app.
  const waiting = useWaiting();
  let screen: ReactNode;
  if (status === 'booting')
    screen = (
      <div className="drag grid h-full place-items-center bg-side">
        <Spinner className="size-8" />
      </div>
    );
  // Web /e/<id>?t=…: the public meeting page of an invited address, signed in or not (ADR-0038).
  else if (platform.kind === 'web' && location.pathname === '/sso/complete') screen = <SsoComplete />;
  // Web /mcp/connect#<request>: an MCP client's OAuth consent (ADR-0158), signed in or after it.
  else if (platform.kind === 'web' && mcpConnectHandle(location.href)) screen = <McpConnect handle={mcpConnectHandle(location.href) as string} />;
  else if (platform.kind === 'web' && location.pathname === '/oauth/consent') {
    const handle = consentHandle(location.href);
    screen = handle ? <OAuthConsent handle={handle} /> : <div className="mat-content grid h-full place-items-center p-6" role="alert">{t('identity.changed')}</div>;
  } else if (formCode) screen = <FormPublicPage code={formCode} />;
  // Web /w/<code>: a shared wiki page, read-only, signed in or not (ADR-0096 §6).
  else if (wikiCode) screen = <WikiPublicPage code={wikiCode} />;
  // Web /c/<code>: a canvas through its public link, view only, signed in or not (ADR-0127 wave 5).
  else if (canvasCode) screen = <CanvasPublicPage code={canvasCode} />;
  else if (eventPage) screen = <EventPublicPage page={eventPage} />;
  // Web /mail-reset/<token>: the one-time mailbox password of a bot reset (ADR-0101). The
  // check runs once; the page owns its token.
  else if (platform.kind === 'web' && mailResetToken()) screen = <MailResetPage token={mailResetToken() as string} />;
  // Web /join/<code>, /r/<code>: the link card first, signed in or not (docs/09 #53).
  else if (landing) screen = <LinkLandingScreen link={landing} />;
  else if (status === 'anon') screen = <AuthScreen />;
  else if (status === 'offline') screen = <OfflineScreen />;
  else if (tooMany) screen = <TooManySessions />;
  else if (waiting) screen = <WaitingScreen />;
  else screen = <AppShell />;
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipP.Provider delayDuration={400} skipDelayDuration={300}>
        {screen}
        {status === 'authed' ? <Dialogs /> : null}
        {/* One-to-one calls (ADR-0034): «Вызов…» / «Входящий звонок» over everything. */}
        {status === 'authed' ? <CallLayer /> : null}
        {status === 'authed' ? <KnockToasts /> : null}
        <Toasts />
      </TooltipP.Provider>
    </QueryClientProvider>
  );
}

import * as TooltipP from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '../components/ui';
import { AuthScreen } from '../features/auth/AuthScreen';
import { LinkLandingScreen } from '../features/auth/LinkLanding';
import { OfflineScreen, TooManySessions } from '../features/auth/SessionScreens';
import { AppShell } from '../features/shell/AppShell';
import { Dialogs } from '../features/shell/Dialogs';
import { Toasts } from '../features/shell/Toasts';
import { useLocale } from '../i18n';
import { useTimeFormat } from '../lib/format';
import { usePrefs } from '../stores/prefs';
import { queryClient } from '../lib/queryClient';
import { platform } from '../platform';
import { useLinkLanding } from '../services/linkLanding';
import { logout } from '../services/session';
import { useSession } from '../stores/session';

export { queryClient };

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST): sign out, back to the login screen. */
    __calabaLogout?: () => Promise<void>;
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
    return () => {
      delete window.__calabaLogout;
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
  let screen: ReactNode;
  if (status === 'booting')
    screen = (
      <div className="drag grid h-full place-items-center bg-side">
        <Spinner className="size-8" />
      </div>
    );
  // Web /join/<code>, /r/<code>: the link card first, signed in or not (docs/09 #53).
  else if (landing) screen = <LinkLandingScreen link={landing} />;
  else if (status === 'anon') screen = <AuthScreen />;
  else if (status === 'offline') screen = <OfflineScreen />;
  else if (tooMany) screen = <TooManySessions />;
  else screen = <AppShell />;
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipP.Provider delayDuration={400} skipDelayDuration={300}>
        {screen}
        {status === 'authed' ? <Dialogs /> : null}
        <Toasts />
      </TooltipP.Provider>
    </QueryClientProvider>
  );
}

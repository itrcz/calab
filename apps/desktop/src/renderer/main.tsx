import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { log } from './lib/log';
import { installSheetGuard, installVisualViewport, registerServiceWorker } from './lib/mobile';
import { installPhoneMenus } from './lib/phoneMenus';
import { t } from './i18n';
import { isWeb, platform } from './platform';
import { installPopoverScroll } from './lib/popoverScroll';
import { installWindowVisibility } from './lib/windowVisibility';
import { startLocale } from './services/locale';
import { installPlayer } from './services/player';
import { installCalls } from './services/call';
import { installResumeVoice } from './services/resumeVoice';
import { installTimeFormat } from './services/timeFormat';
import { bootstrap } from './services/session';
import { installHostIncomingCalls } from './services/hostIncomingCalls';
import { installHostNotifications } from './services/hostNotifications';
import { installHostActivity } from './services/hostActivity';
import './app/styles.css';

window.addEventListener('error', (e) => {
  // Benign by spec: a ResizeObserver callback resized something observed (the chat feed measures
  // rows synchronously — skipAnimationFrameInResizeObserver); the rest is delivered next frame.
  if (!e.error && e.message.startsWith('ResizeObserver loop')) return;
  log.error('uncaught', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => log.error('unhandled rejection', e.reason));

// Desktop: document.visibilityState follows the window (hidden / minimized) — docs/14-energy.md.
if (!isWeb) installWindowVisibility(document, platform.window);

// Lists in popovers/menus scroll inside modal dialogs (docs/09 #118).
installPopoverScroll();

void bootstrap();

// The chat's audio player before any UI can start a track: the REC circle of a recording card
// or a transcript remark plays with no audio attachment mounted yet (docs/09 #57). The element
// itself is created on the first play.
installPlayer();

// One-to-one calls (ADR-0034): leaving the call's voice session or closing the app ends the call.
installCalls();

// After a restart for an update: back into the same room / call (docs/09 #126).
installResumeVoice();
installHostActivity();
installHostNotifications();
installHostIncomingCalls();

// The clock format follows the current workspace (docs/09 #73): `fmt` reads it at call time.
installTimeFormat();

// Web client (ADR-0015/0021): `:root.web` scopes the phone layout (the `mobile:` CSS variant), the
// shell follows the visual viewport (keyboard), and the PWA service worker makes it installable.
if (isWeb) {
  document.documentElement.classList.add('web');
  installVisualViewport();
  installSheetGuard();
  installPhoneMenus({ backLabel: () => t('mobile.back') });
  registerServiceWorker();
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
// The dictionary first (ADR-0022): a non-Russian UI must not flash Russian. startLocale never
// rejects (a failed chunk falls back to en / ru).
void startLocale().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { log } from './lib/log';
import { installSheetGuard, installVisualViewport, registerServiceWorker } from './lib/mobile';
import { isWeb, platform } from './platform';
import { installWindowVisibility } from './lib/windowVisibility';
import { startLocale } from './services/locale';
import { installPlayer } from './services/player';
import { installTimeFormat } from './services/timeFormat';
import { bootstrap } from './services/session';
import './app/styles.css';

window.addEventListener('error', (e) => log.error('uncaught', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => log.error('unhandled rejection', e.reason));

// Desktop: document.visibilityState follows the window (hidden / minimized) — docs/14-energy.md.
if (!isWeb) installWindowVisibility(document, platform.window);

void bootstrap();

// The chat's audio player before any UI can start a track: «Послушать запись» on a recording card
// or a transcript remark plays with no audio attachment mounted yet (docs/09 #57). The element
// itself is created on the first play.
installPlayer();

// The clock format follows the current workspace (docs/09 #73): `fmt` reads it at call time.
installTimeFormat();

// Web client (ADR-0015/0021): `:root.web` scopes the phone layout (the `mobile:` CSS variant), the
// shell follows the visual viewport (keyboard), and the PWA service worker makes it installable.
if (isWeb) {
  document.documentElement.classList.add('web');
  installVisualViewport();
  installSheetGuard();
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

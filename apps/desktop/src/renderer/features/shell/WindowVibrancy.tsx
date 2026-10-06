import { useEffect } from 'react';
import { vibrancyWanted } from '../../../shared/windowMaterial';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { platform } from '../../platform';
import { useSession } from '../../stores/session';

/**
 * macOS native vibrancy (ADR-0075, docs/08 «Материалы»): while the desktop shell is mounted, puts
 * `vibrancy` on <html> so the window layer (title bar, section rail) and the room column paint a
 * translucent tint over main's NSVisualEffectView; the content stays opaque. Login, onboarding and
 * the phone layout keep the solid body. A leaf: it subscribes to its own inputs and renders nothing.
 */
export function WindowVibrancy(): null {
  const os = useSession((s) => s.appInfo?.platform);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const reducedTransparency = useMediaQuery('(prefers-reduced-transparency: reduce)');
  const on =
    platform.kind === 'electron' &&
    vibrancyWanted({
      platform: os ?? '',
      reducedTransparency,
      visualTest,
    });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('vibrancy', on);
    return () => root.classList.remove('vibrancy');
  }, [on]);
  return null;
}

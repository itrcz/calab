import { useEffect, useState } from 'react';
import { canFlipCamera } from '../../lib/media/cameraLogic';
import { isTouchPrimary } from '../../lib/phone';

/**
 * «Переключить камеру» is offered on touch devices that report two or more video inputs (front +
 * back). Enumerated once and on `devicechange`; labels are not needed, so it works before the
 * camera permission is granted (a phone lists its inputs with empty labels then — still ≥ 2).
 */
export function useCanFlipCamera(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    if (!isTouchPrimary()) return;
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md) return;
    let alive = true;
    const load = (): void =>
      void md.enumerateDevices().then(
        (d) => alive && setCan(canFlipCamera(d.filter((x) => x.kind === 'videoinput').length, true)),
        () => undefined,
      );
    load();
    md.addEventListener('devicechange', load);
    return () => {
      alive = false;
      md.removeEventListener('devicechange', load);
    };
  }, []);
  return can;
}

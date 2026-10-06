/**
 * Native window translucency on macOS (ADR-0075, docs/08 «Материалы»): the window gets
 * NSVisualEffectView vibrancy and the renderer tints only the window layer (title bar, section
 * rail) and the room column over it; the content stays opaque. One rule for main (the effect
 * view) and the renderer (the `vibrancy` root class), so both sides agree.
 *
 * Off — solid materials, as everywhere else — when:
 * - not macOS (Windows/Linux and the web never get it);
 * - the user turned «Прозрачность окна» off (AppSettings.windowTranslucency);
 * - the system asks for less transparency (Accessibility → Reduce transparency);
 * - «Слабый компьютер» is on (docs/09 #44, docs/14);
 * - visual tests (screenshots must not depend on the desktop behind the window).
 */
export interface WindowMaterialEnv {
  platform: string;
  /** AppSettings.windowTranslucency; undefined (old settings file) = on. */
  translucency: boolean | undefined;
  reducedTransparency: boolean;
  lowEnd: boolean;
  visualTest: boolean;
}

export const vibrancyWanted = (env: WindowMaterialEnv): boolean =>
  env.platform === 'darwin' && env.translucency !== false && !env.reducedTransparency && !env.lowEnd && !env.visualTest;

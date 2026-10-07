/**
 * Native window translucency on macOS (ADR-0075, docs/08 «Материалы»): the window gets
 * NSVisualEffectView vibrancy and the renderer tints only the window layer (title bar, section
 * rail) and the room column over it; the content stays opaque. One rule for main (the effect
 * view) and the renderer (the `vibrancy` root class), so both sides agree.
 *
 * Always on on macOS — no user setting, «Слабый компьютер» does not switch it off (owner 07.10).
 * Solid materials, as everywhere else, only when:
 * - not macOS (Windows/Linux and the web never get it);
 * - the system asks for less transparency (Accessibility → Reduce transparency);
 * - visual tests (screenshots must not depend on the desktop behind the window).
 */
export interface WindowMaterialEnv {
  platform: string;
  reducedTransparency: boolean;
  visualTest: boolean;
}

export const vibrancyWanted = (env: WindowMaterialEnv): boolean =>
  env.platform === 'darwin' && !env.reducedTransparency && !env.visualTest;

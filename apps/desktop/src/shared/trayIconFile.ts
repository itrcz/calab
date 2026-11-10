/**
 * Which tray image file to load (pure: main/icons.ts does the nativeImage part, tested in
 * trayIconFile.test.ts). The tray has no unread/mention overlay — those live in the tooltip —
 * so the choice depends on platform × «Монохромная иконка в трее» × the taskbar theme only.
 */
export interface TrayIconInput {
  platform: NodeJS.Platform;
  /** AppSettings.monoTrayIcon; honoured on Windows only. */
  mono: boolean;
  /** nativeTheme.shouldUseDarkColorsForSystemIntegratedUI (the taskbar theme, not the app's). */
  systemDark: boolean;
}

/** Whether the setting exists on this platform (the toggle is hidden elsewhere). */
export const monoTrayIconSupported = (platform: string): boolean => platform === 'win32';

export function trayIconFile({ platform, mono, systemDark }: TrayIconInput): string {
  // macOS: always the template (the menu bar recolours it), the setting does not apply.
  if (platform === 'darwin') return 'trayTemplate.png';
  // Dark taskbar → white glyph, light taskbar → black. `@1.25x`/`@1.5x`/`@2x`/`@3x` siblings are picked by DPI.
  if (monoTrayIconSupported(platform) && mono) return systemDark ? 'trayMonoWhite.png' : 'trayMonoBlack.png';
  return 'tray.png';
}

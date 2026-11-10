import { join } from 'node:path';
import { app, nativeImage, nativeTheme, type NativeImage } from 'electron';
import { trayIconFile } from '../shared/trayIconFile';

/**
 * Runtime icons (owner artwork, apps/desktop/build/icons — scripts/gen-icons.sh).
 * Packaged: copied to `resources/icons` by electron-builder (extraResources); dev: read from
 * the source tree. Dock/Finder/installer icons are set by electron-builder, not here.
 */
function iconsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons') : join(app.getAppPath(), 'build', 'icons');
}

/**
 * macOS: monochrome template (menu bar recolours it); Windows with «Монохромная иконка в трее»:
 * a white/black glyph by the taskbar theme; elsewhere the colour icon. @2x/@4x (and Windows
 * @1.25x/@1.5x/@3x) siblings are picked up automatically.
 */
export function trayImage(mono: boolean): NativeImage {
  const platform = process.platform;
  // The taskbar theme, not the app's (`shouldUseDarkColors` follows the app theme); win32/darwin only.
  const systemDark = platform === 'win32' ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI : nativeTheme.shouldUseDarkColors;
  const img = nativeImage.createFromPath(join(iconsDir(), 'tray', trayIconFile({ platform, mono, systemDark })));
  if (platform === 'darwin') img.setTemplateImage(true);
  return img;
}

/** Window icon for Linux (Windows takes it from the .exe; macOS from the bundle). */
export function windowIconPath(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  return app.isPackaged ? join(iconsDir(), 'window.png') : join(iconsDir(), 'linux', '512x512.png');
}

/** The colour app icon at `size` px (a drag image fallback, main/dragOut.ts); every platform ships it. */
export function appIconImage(size: number): NativeImage {
  const path = app.isPackaged ? join(iconsDir(), 'window.png') : join(iconsDir(), 'linux', '512x512.png');
  return nativeImage.createFromPath(path).resize({ width: size, height: size });
}

/** Dev only (unpackaged Electron shows its own Dock icon): use the app artwork. */
export function applyDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return;
  app.dock?.setIcon(nativeImage.createFromPath(join(iconsDir(), 'mac', 'icon.png')));
}

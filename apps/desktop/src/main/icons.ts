import { join } from 'node:path';
import { app, nativeImage, type NativeImage } from 'electron';

/**
 * Runtime icons (owner artwork, apps/desktop/build/icons — scripts/gen-icons.sh).
 * Packaged: copied to `resources/icons` by electron-builder (extraResources); dev: read from
 * the source tree. Dock/Finder/installer icons are set by electron-builder, not here.
 */
function iconsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons') : join(app.getAppPath(), 'build', 'icons');
}

/** macOS: monochrome template (menu bar recolours it); elsewhere the colour icon. @2x/@4x are picked up automatically. */
export function trayImage(): NativeImage {
  const mac = process.platform === 'darwin';
  const img = nativeImage.createFromPath(join(iconsDir(), 'tray', mac ? 'trayTemplate.png' : 'tray.png'));
  if (mac) img.setTemplateImage(true);
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

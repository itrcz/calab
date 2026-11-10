import { describe, expect, it } from 'vitest';
import { monoTrayIconSupported, trayIconFile } from './trayIconFile';

describe('trayIconFile', () => {
  it('Windows, setting off → colour icon whatever the theme', () => {
    expect(trayIconFile({ platform: 'win32', mono: false, systemDark: true })).toBe('tray.png');
    expect(trayIconFile({ platform: 'win32', mono: false, systemDark: false })).toBe('tray.png');
  });
  it('Windows, setting on → white on a dark taskbar, black on a light one', () => {
    expect(trayIconFile({ platform: 'win32', mono: true, systemDark: true })).toBe('trayMonoWhite.png');
    expect(trayIconFile({ platform: 'win32', mono: true, systemDark: false })).toBe('trayMonoBlack.png');
  });
  it('macOS always uses the template icon; Linux the colour one (the setting is ignored)', () => {
    for (const mono of [true, false]) {
      for (const systemDark of [true, false]) {
        expect(trayIconFile({ platform: 'darwin', mono, systemDark })).toBe('trayTemplate.png');
        expect(trayIconFile({ platform: 'linux', mono, systemDark })).toBe('tray.png');
      }
    }
  });
  it('the toggle is offered on Windows only', () => {
    expect(monoTrayIconSupported('win32')).toBe(true);
    expect(monoTrayIconSupported('darwin')).toBe(false);
    expect(monoTrayIconSupported('linux')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { vibrancyWanted, type WindowMaterialEnv } from './windowMaterial';

const mac: WindowMaterialEnv = { platform: 'darwin', translucency: true, reducedTransparency: false, lowEnd: false, visualTest: false };

describe('vibrancyWanted', () => {
  it('is on for macOS by default (old settings without the key too)', () => {
    expect(vibrancyWanted(mac)).toBe(true);
    expect(vibrancyWanted({ ...mac, translucency: undefined })).toBe(true);
  });
  it('is never on outside macOS', () => {
    expect(vibrancyWanted({ ...mac, platform: 'win32' })).toBe(false);
    expect(vibrancyWanted({ ...mac, platform: 'linux' })).toBe(false);
    expect(vibrancyWanted({ ...mac, platform: 'web' })).toBe(false);
  });
  it('falls back to solid for the setting, reduced transparency, weak computer and visual tests', () => {
    expect(vibrancyWanted({ ...mac, translucency: false })).toBe(false);
    expect(vibrancyWanted({ ...mac, reducedTransparency: true })).toBe(false);
    expect(vibrancyWanted({ ...mac, lowEnd: true })).toBe(false);
    expect(vibrancyWanted({ ...mac, visualTest: true })).toBe(false);
  });
});

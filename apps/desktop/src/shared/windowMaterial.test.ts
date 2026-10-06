import { describe, expect, it } from 'vitest';
import { vibrancyWanted, type WindowMaterialEnv } from './windowMaterial';

const mac: WindowMaterialEnv = { platform: 'darwin', reducedTransparency: false, visualTest: false };

describe('vibrancyWanted', () => {
  it('is on for macOS, always', () => {
    expect(vibrancyWanted(mac)).toBe(true);
  });
  it('is off elsewhere', () => {
    expect(vibrancyWanted({ ...mac, platform: 'win32' })).toBe(false);
    expect(vibrancyWanted({ ...mac, platform: 'linux' })).toBe(false);
    expect(vibrancyWanted({ ...mac, platform: 'web' })).toBe(false);
  });
  it('falls back to solid for reduced transparency and visual tests', () => {
    expect(vibrancyWanted({ ...mac, reducedTransparency: true })).toBe(false);
    expect(vibrancyWanted({ ...mac, visualTest: true })).toBe(false);
  });
});

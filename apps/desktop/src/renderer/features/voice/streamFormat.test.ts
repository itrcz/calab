import { ScreenSharePreset } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import type { CaptureSource } from '../../../shared/ipc';
import { thumbSizeFor } from '../../../shared/captureThumb';
import { layerLabel, pickerLayout, pipSize, presetDetail, presetOptions, presetSummary, presetText, qualityOptions, splitSources, viewersText } from './streamFormat';

describe('presetSummary', () => {
  it('says the preset in words', () => {
    expect(presetSummary(ScreenSharePreset.H1080, 'detail')).toBe('Текст • 1080p • 15 fps');
    expect(presetSummary(ScreenSharePreset.ECONOMY, 'motion')).toBe('Видео • 720p • 5 fps');
    expect(presetSummary(ScreenSharePreset.ORIGINAL, 'detail')).toBe('Текст • Исходное • 30 fps');
  });
});

describe('presetText / presetDetail', () => {
  it('keeps select labels short and never repeats the resolution', () => {
    expect(presetText(ScreenSharePreset.H1080)).toBe('1080p · 15 fps');
    expect(presetText(ScreenSharePreset.ECONOMY)).toBe('Экономия · 5 fps');
    expect(presetText(ScreenSharePreset.ORIGINAL)).toBe('Максимум · 30 fps');
    for (const p of [ScreenSharePreset.ECONOMY, ScreenSharePreset.H720, ScreenSharePreset.H1080, ScreenSharePreset.ORIGINAL] as const) {
      expect(presetText(p).length).toBeLessThanOrEqual(18);
    }
  });
  it('puts the parameters in the detail line', () => {
    expect(presetDetail(ScreenSharePreset.H1080)).toBe('1080p, 15 fps, до 2,0 Мбит/с');
    expect(presetDetail(ScreenSharePreset.ORIGINAL)).toBe('исходное разрешение, 30 fps, до 4,0 Мбит/с');
  });
});

describe('presetOptions', () => {
  it('disables presets above the room limit with the reason', () => {
    const o = presetOptions(ScreenSharePreset.H1080);
    expect(o.map((x) => x.label)).toEqual(['Экономия', '720p', '1080p', 'Макс.']);
    expect(o.map((x) => x.disabledReason !== null)).toEqual([false, false, false, true]);
    expect(o[3]?.disabledReason).toBe('Недоступно: в этой комнате качество не выше «1080p»');
    expect(presetOptions(ScreenSharePreset.ORIGINAL).every((x) => x.disabledReason === null)).toBe(true);
    // The plan's cap (ADR-0024): a lock with «Доступно на тарифе Team»; the room's reason wins above both.
    const free = presetOptions(ScreenSharePreset.H1080, ScreenSharePreset.H720);
    expect(free.map((x) => x.lock)).toEqual([null, null, 'plan', 'room']);
    expect(free[2]?.disabledReason).toBe('Доступно на тарифе Team');
  });
});

describe('splitSources', () => {
  it('puts windows under «Приложения» and screens under «Весь экран»', () => {
    const src = (id: string, kind: 'screen' | 'window'): CaptureSource => ({ id, name: id, kind, thumbnail: '', displayId: '' });
    const r = splitSources([src('screen:1', 'screen'), src('window:1', 'window'), src('window:2', 'window')]);
    expect(r.apps.map((s) => s.id)).toEqual(['window:1', 'window:2']);
    expect(r.screens.map((s) => s.id)).toEqual(['screen:1']);
  });
});

describe('quality menu', () => {
  it('rounds layer heights to familiar names', () => {
    expect(layerLabel(1078)).toBe('1080p');
    expect(layerLabel(359)).toBe('360p');
    expect(layerLabel(720)).toBe('720p');
    expect(layerLabel(1912)).toBe('1912p');
  });

  it('lists Auto and each layer once, largest first', () => {
    expect(
      qualityOptions([
        { quality: 'low', height: 360 },
        { quality: 'high', height: 1078 },
      ]),
    ).toEqual([
      { value: 'auto', label: 'Авто' },
      { value: 'high', label: '1080p' },
      { value: 'low', label: '360p' },
    ]);
    expect(qualityOptions([])).toEqual([{ value: 'auto', label: 'Авто' }]);
  });
});

describe('viewersText', () => {
  it('uses Russian plurals', () => {
    expect(viewersText(0)).toBe('0 смотрят');
    expect(viewersText(1)).toBe('1 смотрит');
    expect(viewersText(3)).toBe('3 смотрят');
    expect(viewersText(21)).toBe('21 смотрит');
  });
});

describe('pipSize', () => {
  it('is 320×180 in wide windows, 240×135 under 1200 px', () => {
    expect(pipSize(true, 500, 12)).toEqual({ w: 320, h: 180 });
    expect(pipSize(false, 500, 12)).toEqual({ w: 240, h: 135 });
  });
  it('shrinks when the message area is short', () => {
    expect(pipSize(true, 190, 12)).toEqual({ w: 240, h: 135 });
    expect(pipSize(true, 150, 12)).toEqual({ w: 192, h: 108 });
    expect(pipSize(false, 40, 12)).toEqual({ w: 192, h: 108 });
  });
});

describe('pickerLayout + thumbSizeFor (docs/09 #17)', () => {
  it('one source: one centred card, ≤ 60 % of the area wide', () => {
    // 900 px dialog − 2 × 20 px padding; plenty of height.
    expect(pickerLayout(860, 600, 1)).toEqual({ single: true, card: 516, preview: 504 });
    // …and its thumbnail on a Retina display: the preview box in device pixels.
    expect(thumbSizeFor(504, 2)).toEqual({ width: 1008, height: 567 });
  });
  it('one source in a short area: the card shrinks to fit the height', () => {
    const l = pickerLayout(860, 300, 1);
    expect(l.single).toBe(true);
    expect((l.preview * 9) / 16 + 12 + 28).toBeLessThanOrEqual(300);
  });
  it('several sources: two columns with a 12 px gap', () => {
    expect(pickerLayout(860, 400, 2)).toEqual({ single: false, card: 424, preview: 412 });
    expect(pickerLayout(860, 400, 7).card).toBe(424);
  });
  it('the thumbnail follows the card on resize', () => {
    const small = thumbSizeFor(pickerLayout(600, 400, 3).preview, 2);
    const big = thumbSizeFor(pickerLayout(860, 400, 3).preview, 2);
    expect(big.width).toBeGreaterThan(small.width);
  });
});

import { describe, expect, it } from 'vitest';
import { goneDetails, RELOADS_MAX, RELOADS_WINDOW_MS, RendererCrashBudget } from './crashRecovery';

describe('RendererCrashBudget', () => {
  it('reloads after a crash, never after a clean exit', () => {
    const b = new RendererCrashBudget();
    expect(b.shouldReload('clean-exit', 0)).toBe(false);
    expect(b.shouldReload('crashed', 0)).toBe(true);
    expect(b.shouldReload('oom', 1)).toBe(true);
    expect(b.shouldReload('killed', 2)).toBe(true);
  });

  it('stops after RELOADS_MAX crashes within the window, resumes once they age out', () => {
    const b = new RendererCrashBudget();
    for (let i = 0; i < RELOADS_MAX; i++) expect(b.shouldReload('crashed', i * 1000)).toBe(true);
    expect(b.shouldReload('crashed', 5000)).toBe(false);
    expect(b.shouldReload('crashed', RELOADS_WINDOW_MS + 1)).toBe(true);
  });
});

describe('goneDetails', () => {
  it('adds the NTSTATUS hex for Windows exit codes', () => {
    expect(goneDetails({ type: 'Utility', serviceName: 'node.mojom.NodeService', name: 'Calab Mail', reason: 'crashed', exitCode: -1073741819 })).toEqual({
      type: 'Utility',
      service: 'node.mojom.NodeService',
      name: 'Calab Mail',
      reason: 'crashed',
      exitCode: -1073741819,
      exitCodeHex: '0xC0000005',
    });
    expect(goneDetails({ reason: 'clean-exit', exitCode: 0 })).toEqual({ reason: 'clean-exit', exitCode: 0 });
  });
});

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BILLING_BITS } from '@calaba/protocol';
import { resetNativeShellForTests } from '../../platform/nativeShell';
import { BuyStorage } from './UsageMeter';
import { DiskDialogs } from './Dialogs';
import { useDiskUi } from '../../stores/diskUi';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', app: { log: vi.fn() } } }));
vi.mock('../../services/disk', () => ({ watchUsage: () => () => undefined }));
vi.mock('../workspace/billing/access', () => ({ useBillingBits: () => BILLING_BITS.VIEW }));
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { delete window.CalabHostActivity; });

describe('Disk purchase surfaces follow native-shell billing policy (ADR-0148)', () => {
  it.each([true, false])('native shell = %s: usage remains readable, packs and quota CTA follow policy', (ios) => {
    resetNativeShellForTests();
    if (ios) Object.defineProperty(window, 'CalabHostActivity', { value: { version: 1, platform: 'ios' }, configurable: true });
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(BuyStorage, { workspaceId: 'w' })));
      expect(!!host.querySelector('[data-testid="disk-buy"]')).toBe(!ios);
      for (const full of [false, true]) {
        act(() => {
          useDiskUi.getState().openDialog({ kind: 'usage', wsId: 'w', full });
          root.render(createElement(DiskDialogs, { workspaceId: 'w' }));
        });
        expect(document.querySelector('[data-testid="disk-usage"]')).not.toBeNull();
        expect(!!document.querySelector('[data-testid="disk-buy-open"]')).toBe(!ios);
      }
    } finally { act(() => root.unmount()); host.remove(); }
  });
});

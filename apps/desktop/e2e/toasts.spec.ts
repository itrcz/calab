import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

/** Real React/DOM lifecycle, without a server or LiveKit. Visual mode must stay off:
 * screenshot tests deliberately freeze toast timers and cannot catch these regressions. */
let server: ViteDevServer;
const port = Number(process.env['CALABA_VISUAL_MOCK_PORT'] ?? 39371);
const entry = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { Provider } from '@radix-ui/react-tooltip';
  import { Toasts } from '/features/shell/Toasts.tsx';
  import { useToasts } from '/stores/toasts.ts';
  import '/app/styles.css';
  document.documentElement.classList.add('dark');
  flushSync(() => createRoot(document.getElementById('root')).render(
    React.createElement(Provider, null, React.createElement(Toasts))
  ));
  window.toastTest = {
    push: (kind, text, actionable = false, durationMs) => flushSync(() => useToasts.getState().push(
      kind, text, actionable ? { label: 'Retry', run() {} } : undefined, durationMs
    )),
  };
`;


test.use({ viewport: { width: 960, height: 600 }, launchOptions: { args: ['--mute-audio'] } });
test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.web.config.ts'),
    mode: 'web',
    server: { host: '127.0.0.1', port, strictPort: true },
    plugins: [{
      name: 'toast-lifecycle-fixture',
      resolveId: (id) => id === '/toast-test-entry.js' ? '\0toast-test-entry' : undefined,
      load: (id) => id === '\0toast-test-entry' ? entry : undefined,
      configureServer(vite) {
        vite.middlewares.use('/toast-test.html', (_req, res, next) => {
          const html = '<!doctype html><html><head></head><body><button id="outside">Outside</button><div id="root"></div><script type="module" src="/toast-test-entry.js"></script></body></html>';
          void vite.transformIndexHtml('/toast-test.html', html).then((html) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
          }).catch(next);
        });
      },
    }],
  });
  await server.listen();
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/toast-test.html`);
  await page.waitForFunction('window.toastTest !== undefined');
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await page.mouse.move(0, 0);
});

async function push(page: Page, text: string, kind: 'info' | 'success' | 'error' = 'info', actionable = false, durationMs?: number): Promise<void> {
  await page.evaluate(`window.toastTest.push(${JSON.stringify(kind)}, ${JSON.stringify(text)}, ${String(actionable)}, ${String(durationMs)})`);
  await expect(page.getByTestId('toast').filter({ hasText: text })).toBeVisible();
}

test('ordinary notifications dismiss after six seconds', async ({ page }, info) => {
  await push(page, 'This meeting is being recorded');
  await page.screenshot({ path: info.outputPath('toast-visible.png'), animations: 'disabled' });
  await page.clock.runFor(5900);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await page.clock.runFor(200);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('toast-dismissed.png'), animations: 'disabled' });
});

test('closing a focused toast does not pause subsequent notifications', async ({ page }) => {
  await push(page, 'First notification');
  await page.getByTestId('toast').getByRole('button').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await push(page, 'This meeting is being recorded');
  await page.clock.runFor(6100);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

for (const remove of ['close button', 'action button', 'dedupe', 'queue eviction'] as const) {
  test(`${remove} releases focus after removing a toast`, async ({ page }) => {
    await push(page, 'Focused notification', 'info', remove === 'action button');
    await page.getByTestId('toast').getByRole('button').last().focus();
    if (remove === 'dedupe') {
      await push(page, 'Focused notification');
    } else if (remove === 'queue eviction') {
      for (let i = 0; i < 4; i++) await push(page, `New notification ${i}`);
    } else {
      await push(page, 'Remaining notification');
      const first = page.getByTestId('toast').first();
      await first.getByRole('button').first().click();
      await expect(page.getByTestId('toast')).toHaveCount(1);
    }
    await page.mouse.move(0, 0);
    await expect(page.getByTestId('toast').getByRole('button').first()).not.toBeFocused();
    await page.clock.runFor(6100);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
}

test('hover pauses the stack and resumes its remaining time after leaving', async ({ page }) => {
  await push(page, 'Hovered notification');
  await page.clock.runFor(2000);
  await page.getByTestId('toast').hover();
  await page.clock.runFor(10000);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await page.mouse.move(0, 0);
  await page.clock.runFor(3900);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await page.clock.runFor(200);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('focus pauses surviving toasts even when another toast changes', async ({ page }) => {
  await push(page, 'Focused notification');
  await page.clock.runFor(2000);
  await page.getByTestId('toast').getByRole('button').focus();
  await push(page, 'Another notification');
  await page.clock.runFor(10000);
  await expect(page.getByTestId('toast')).toHaveCount(2);
  await page.locator('#outside').focus();
  await page.clock.runFor(3900);
  await expect(page.getByTestId('toast')).toHaveCount(2);
  await page.clock.runFor(200);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await page.clock.runFor(2000);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('notifications raised while hidden wait for the window to be shown', async ({ page }) => {
  const hidden = async (value: boolean): Promise<void> => {
    await page.evaluate(`
      Object.defineProperty(document, 'hidden', { configurable: true, value: ${String(value)} });
      document.dispatchEvent(new Event('visibilitychange'));
    `);
  };
  await hidden(true);
  await push(page, 'Background notification');
  await page.clock.runFor(10000);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await hidden(false);
  await page.clock.runFor(5900);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await page.clock.runFor(200);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('custom durations and actionable errors retain their existing lifetimes', async ({ page }) => {
  await push(page, 'Retry needed', 'error', true);
  await push(page, 'Device changed', 'success', true, 8000);
  await push(page, 'Ordinary error', 'error');
  await page.clock.runFor(6100);
  await expect(page.getByTestId('toast')).toHaveCount(2);
  await page.clock.runFor(1800);
  await expect(page.getByTestId('toast')).toHaveCount(2);
  await page.clock.runFor(200);
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await expect(page.getByTestId('toast')).toContainText('Retry needed');
  await page.clock.runFor(60000);
  await expect(page.getByTestId('toast')).toHaveCount(1);
});

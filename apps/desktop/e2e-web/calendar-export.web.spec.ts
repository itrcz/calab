import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

// UI behavior only: real permissions, ICS and revocation have server integration coverage.
// API routes are intercepted, so the PWA service worker must not bypass page routing.
test.use({ serviceWorkers: 'block' });
const port = Number(process.env['CALAB_CALENDAR_MOCK_PORT'] ?? 39486);
const base = `http://127.0.0.1:${port}`;
let mock: ChildProcess;
test.beforeAll(async () => {
  mock = spawn(process.execPath, ['--import', 'tsx', 'e2e-support/mock-server.ts', '--port', String(port), '--static', 'dist-web', '--quiet'], {
    cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('calendar UI mock did not start')), 30000);
    mock.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('Calaba mock server')) { clearTimeout(timer); resolve(); }
    });
    mock.once('exit', (code) => { clearTimeout(timer); reject(new Error(`calendar UI mock exited: ${String(code)}`)); });
  });
});
test.afterAll(() => { mock.kill('SIGTERM'); });
for (const screen of [
  { name: 'desktop-dark', width: 960, height: 760, theme: 'dark' },
  { name: 'desktop-light', width: 960, height: 760, theme: 'light' },
  { name: 'phone', width: 390, height: 844, theme: 'dark' },
]) {
  test(`calendar export lifecycle: ${screen.name}`, async ({ page }) => {
    expect((await fetch(`${base}/__mock/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).ok).toBe(true);
    const token = '12345678-1234-4234-8234-123456789abc.' + 'a'.repeat(43);
    const grant = {
      feedUrl: `https://app.example.com/api/calendar-feed.ics?t=${token}`,
      webcalUrl: `webcal://app.example.com/api/calendar-feed.ics?t=${token}`,
      connectUrl: `https://app.example.com/api/calendar-connect?t=${token}`,
    };
    let active = false;
    let rotated = false;
    await page.route('**/api/workspaces/*/calendar-subscription', async (route) => {
      const method = route.request().method();
      if (method === 'DELETE') {
        active = false;
        await route.fulfill({ status: 204 });
        return;
      }
      if (method === 'POST') active = true;
      if (method === 'PUT') rotated = true;
      await route.fulfill({
        json: active ? Object.fromEntries(Object.entries(grant).map(([k, v]) => [k, rotated ? v.replace('12345678-', '22345678-') : v])) : {},
      });
    });
    await page.route('**/api/workspaces/*/calendar.ics?*', (route) =>
      route.fulfill({ contentType: 'text/calendar', body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' }),
    );
    await page.setViewportSize({ width: screen.width, height: screen.height });
    await page.clock.setFixedTime(new Date('2026-01-15T10:30:00Z'));
    await page.goto(`${base}/?visual-test`);
    await page.evaluate(
      (theme) => localStorage.setItem('calaba-prefs', JSON.stringify({ state: { theme, onboarded: true, locale: 'ru' }, version: 1 })),
      screen.theme,
    );
    await page.reload();
    await page.getByLabel('Email').fill('owner@calaba.test');
    await page.getByLabel('Пароль', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    const phone = screen.name === 'phone';
    if (phone) {
      await expect(page.getByTestId('phone-tabbar')).toBeVisible();
      if (!(await page.getByTestId('phone-tab-calendar').isVisible())) {
        await page.getByTestId('phone-tab-more').click();
        await page.getByTestId('more-row-calendar').click();
      } else await page.getByTestId('phone-tab-calendar').click();
    } else await page.getByTestId('section-calendar').click();
    const menu = page.getByTestId(phone ? 'day-more' : 'calendar-more');
    await menu.click();
    await page.getByTestId('calendar-download').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('без дальнейших обновлений');
    const download = page.waitForEvent('download', { timeout: 12000 });
    await page.getByTestId('calendar-save').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('calab.ics');
    expect(readFileSync((await file.path()), 'utf8')).toContain('BEGIN:VCALENDAR');
    await expect(dialog).toHaveCount(0);
    await menu.click();
    await page.getByTestId('calendar-subscribe').click();
    await expect(page.getByTestId('calendar-activate')).toBeVisible();
    expect(active).toBe(false);
    await page.getByTestId('calendar-activate').click();
    await expect(page.getByTestId('calendar-apple')).toBeVisible();

    if (!phone) await expect(page.getByTestId('calendar-qr')).toBeVisible();
    else await expect(page.getByTestId('calendar-qr')).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const dir = process.env['CALAB_CALENDAR_SHOTS'];
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${screen.name}.png`) });
      if (!phone) await page.getByTestId('calendar-qr').screenshot({ path: join(dir, `${screen.name}-qr.png`) });
    }
    await page.getByText('Другие приложения и управление подпиской', { exact: true }).click();
    const link = page.getByLabel('Ссылка для подписки');
    await expect(link).toHaveValue(grant.feedUrl);
    await page.getByRole('button', { name: 'Заменить ссылку', exact: true }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: 'Заменить ссылку', exact: true }).click();
    await expect(link).toHaveValue(grant.feedUrl.replace('12345678-', '22345678-'));
    await page.getByRole('button', { name: 'Отключить подписку', exact: true }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: 'Отключить подписку', exact: true }).click();
    await expect(page.getByTestId('calendar-activate')).toBeVisible();
    await expect(link).toHaveCount(0);
    await expect(page.getByTestId('calendar-qr')).toHaveCount(0);
    expect(active).toBe(false);
  });
}

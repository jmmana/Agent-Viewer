import { test, expect } from '@playwright/test';
import type {} from './fixtures/crew-desktop';
declare global { interface Window { __stationDraws: { x: number; y: number }[] } }
const url = '/tests/e2e/fixtures/crew-desktop.html';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__stationDraws = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source: CanvasImageSource, ...coords: number[]) {
      if ((source as HTMLImageElement).src?.includes('ceo-workstation-v2')) window.__stationDraws.push({ x: coords[0], y: coords[1] });
      return Reflect.apply(original, this, [source, ...coords]);
    };
  });
});
test('puesto CEO usa ocho recortes propios, zoom y móvil sin descargar en reposo', async ({ page }, info) => {
  await page.goto(url);
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 1.');
  expect(await page.evaluate(() => window.__stationDraws)).toEqual([]);
  await page.evaluate(() => window.__crewDesktopFixture({ status: 'CODING' }));
  for (const view of ['front', 'right', 'back', 'left']) {
    await page.locator('#crew-view').selectOption(view);
    await page.waitForTimeout(250);
  }
  await expect.poll(() => page.evaluate(() => new Set(window.__stationDraws.map(draw => `${draw.x}:${draw.y}`)).size)).toBe(8);
  await page.locator('#crew-view').selectOption('front');
  for (let i = 0; i < 7; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Focus Fixture CEO', exact: true }).click();
  await page.screenshot({ path: info.outputPath('workstation-zoom.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Fit room', exact: true }).click();
  await page.evaluate(() => window.__crewDesktopFixture({ locale: 'es' }));
  await page.screenshot({ path: info.outputPath('workstation-mobile.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(100);
  const count = await page.evaluate(() => window.__stationDraws.length); await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__stationDraws.length)).toBe(count);
  await page.locator('#crew-room').selectOption('development');
  await expect(page.getByText('Oficina vacía. El mobiliario sigue disponible.')).toBeVisible();
});
test('original ausente conserva actor y muebles existentes sin duplicar el puesto', async ({ page }) => {
  await page.route('**/ceo-workstation-v2.png', route => route.abort());
  await page.goto(url); await page.evaluate(() => window.__crewDesktopFixture({ status: 'CODING' }));
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 1.');
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__stationDraws)).toEqual([]);
  await expect(page.locator('canvas')).toHaveCount(1);
});

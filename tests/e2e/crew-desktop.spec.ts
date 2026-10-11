import { test, expect } from '@playwright/test';
type Draw = { url: string; x: number; y: number };
declare global { interface Window { __deskDraws: Draw[] } }
const url = '/tests/e2e/fixtures/crew-desktop.html';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__deskDraws = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source: CanvasImageSource, ...coordinates: number[]) {
      const src = (source as HTMLImageElement).src;
      if (src && /ceo-(sit|stand|typing|turn)-/.test(src)) window.__deskDraws.push({ url: src, x: coordinates[0], y: coordinates[1] });
      return Reflect.apply(original, this, [source, ...coordinates]);
    };
  });
});
test('cuatro cámaras y clips reales en sala CEO, sin alterar el snapshot', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 1.');
  const original = await page.getByTestId('original-snapshot').textContent();
  for (const view of ['front', 'right', 'back', 'left']) {
    await page.locator('#crew-view').selectOption(view);
    await page.evaluate(() => { window.__deskDraws = []; window.__crewDesktopFixture({ status: 'CODING' }); });
    await expect.poll(() => page.evaluate(() => new Set(window.__deskDraws.filter(draw => draw.url.includes('ceo-typing')).map(draw => `${draw.x}:${draw.y}`)).size)).toBe(4);
    await page.getByRole('button', { name: 'Focus Fixture CEO', exact: true }).click();
    await page.screenshot({ path: info.outputPath(`desktop-${view}.png`) });
    await page.evaluate(() => window.__crewDesktopFixture({ status: 'IDLE' }));
    await expect.poll(() => page.evaluate(() => new Set(window.__deskDraws.filter(draw => draw.url.includes('ceo-stand')).map(draw => `${draw.x}:${draw.y}`)).size)).toBe(4);
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__crewDesktopFixture({ facing: 'SW' }));
    await expect.poll(() => page.evaluate(() => new Set(window.__deskDraws.filter(draw => draw.url.includes('ceo-turn')).map(draw => `${draw.x}:${draw.y}`)).size)).toBe(4);
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__crewDesktopFixture({ facing: 'SE' }));
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => new Set(window.__deskDraws.filter(draw => draw.url.includes('ceo-sit')).map(draw => `${draw.x}:${draw.y}`)).size)).toBe(4);
  }
  await page.evaluate(() => window.__crewDesktopFixture({ second: true }));
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 2.');
  expect(await page.getByTestId('original-snapshot').textContent()).toBe(original);
  expect(errors).toEqual([]);
});
test('movimiento reducido, fallback bilingüe y cancelación al salir', async ({ page }) => {
  await page.route('**/ceo-typing-v1.png', route => route.abort());
  await page.goto(url); await page.evaluate(() => window.__crewDesktopFixture({ status: 'CODING' }));
  await expect(page.getByTestId('crew-action-fallback')).toContainText('Desk animation unavailable');
  await page.evaluate(() => window.__crewDesktopFixture({ locale: 'es' }));
  await expect(page.getByTestId('crew-action-fallback')).toContainText('Animación de escritorio no disponible');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(100);
  const count = await page.evaluate(() => window.__deskDraws.length); await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__deskDraws.length)).toBe(count);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#crew-room').selectOption('development'); await page.waitForTimeout(100);
  const empty = await page.evaluate(() => window.__deskDraws.length); await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__deskDraws.length)).toBe(empty);
  await page.evaluate(() => window.__crewDesktopFixture({ mounted: false }));
  await expect(page.locator('canvas')).toHaveCount(0);
});

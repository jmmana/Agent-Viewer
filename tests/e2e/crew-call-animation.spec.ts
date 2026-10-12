import { test, expect } from '@playwright/test';
import type { DesktopPatch } from './fixtures/crew-desktop';
import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('../../assets/crew/clips/calls.v1.json', import.meta.url), 'utf8')) as { clips: { clip: string; facing: string; frames: { x: number; y: number }[] }[] };
type Draw = { url: string; x: number; y: number };
declare global { interface Window { __callDraws: Draw[] } }
const url = '/tests/e2e/fixtures/crew-desktop.html';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__callDraws = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source: CanvasImageSource, ...coordinates: number[]) {
      const src = (source as HTMLImageElement).src;
      if (src && /ceo-call(-pickup)?-v/.test(src)) window.__callDraws.push({ url: src, x: coordinates[0], y: coordinates[1] });
      return Reflect.apply(original, this, [source, ...coordinates]);
    };
  });
});
test('coge, habla y cuelga con cuadros reales en cuatro cámaras, vuelve a reposo', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const snapshot = await page.getByTestId('original-snapshot').textContent();
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 1.');
  for (const [view, facing] of [['front', 'front'], ['right', 'left'], ['back', 'back'], ['left', 'right']]) {
    await page.locator('#crew-view').selectOption(view);
    await page.getByRole('button', { name: 'Focus Fixture CEO', exact: true }).click();
    await page.evaluate((patch: DesktopPatch) => { window.__callDraws = []; window.__crewDesktopFixture(patch); }, { status: 'PHONE_CALL' });
    const coords = (clip: string) => catalog.clips.find(item => item.clip === clip && item.facing === facing)!.frames.map(frame => `${frame.x}:${frame.y}`);
    await expect.poll(() => page.evaluate(() => [...new Set(window.__callDraws.filter(draw => draw.url.includes('ceo-call-v')).map(draw => `${draw.x}:${draw.y}`))].sort())).toEqual(coords('call').sort());
    expect(await page.evaluate(() => [...new Set(window.__callDraws.filter(draw => draw.url.includes('call-pickup')).map(draw => `${draw.x}:${draw.y}`))])).toEqual(coords('call-pickup'));
    await page.screenshot({ path: info.outputPath(`call-${view}.png`) });
    await page.evaluate(() => { window.__callDraws = []; window.__crewDesktopFixture({ status: 'IDLE' }); });
    await expect.poll(() => page.evaluate(() => [...new Set(window.__callDraws.filter(draw => draw.url.includes('call-pickup')).map(draw => `${draw.x}:${draw.y}`))])).toEqual(coords('call-hangup'));
    await page.waitForTimeout(300);
    const stopped = await page.evaluate(() => window.__callDraws.length);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__callDraws.length)).toBe(stopped);
  }
  expect(await page.getByTestId('original-snapshot').textContent()).toBe(snapshot);
  expect(errors).toEqual([]);
});
test('aislamiento por actor/sala, móvil, movimiento reducido y fallo bilingüe', async ({ page }, info) => {
  const requested: string[] = []; page.on('request', request => requested.push(request.url()));
  await page.goto(url);
  await page.evaluate(() => window.__crewDesktopFixture({ status: 'PHONE_CALL', second: true, secondFacing: 'SE' }));
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 2.');
  await expect.poll(() => page.evaluate(() => window.__callDraws.length)).toBeGreaterThan(2);
  expect(requested.some(value => value.includes('phone-front'))).toBe(false);
  await page.locator('#crew-room').selectOption('development');
  await page.waitForTimeout(100);
  const empty = await page.evaluate(() => window.__callDraws.length);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__callDraws.length)).toBe(empty);
  await page.locator('#crew-room').selectOption('ceo');
  await expect(page.getByText('Fixture CEO: PHONE_CALL', { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__callDraws.length)).toBeGreaterThan(empty);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  const reduced = await page.evaluate(() => window.__callDraws.length);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__callDraws.length)).toBe(reduced);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__crewDesktopFixture({ second: false, locale: 'es' }));
  await page.locator('#crew-view').selectOption('right');
  await page.screenshot({ path: info.outputPath('call-mobile-reduced.png') });
  await page.route('**/ceo-call-v1.png', route => route.abort());
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.getByTestId('crew-action-fallback')).toContainText('Animación del personaje no disponible');
  await page.evaluate(() => window.__crewDesktopFixture({ locale: 'en' }));
  await expect(page.getByTestId('crew-action-fallback')).toContainText('Actor animation unavailable');
  await page.evaluate(() => window.__crewDesktopFixture({ mounted: false }));
  await expect(page.locator('canvas')).toHaveCount(0);
});

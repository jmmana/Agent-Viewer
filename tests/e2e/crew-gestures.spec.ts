import { test, expect } from '@playwright/test';
import type { DesktopPatch } from './fixtures/crew-desktop';
import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('../../assets/crew/clips/gestures.v1.json', import.meta.url), 'utf8')) as { clips: { clip: string; facing: string; frames: { x: number; y: number }[] }[] };
type Draw = { url: string; x: number; y: number };
declare global { interface Window { __gestureDraws: Draw[] } }
const url = '/tests/e2e/fixtures/crew-desktop.html';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__gestureDraws = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source: CanvasImageSource, ...coordinates: number[]) {
      const src = (source as HTMLImageElement).src;
      if (src && /ceo-(think|talk|review)-/.test(src)) window.__gestureDraws.push({ url: src, x: coordinates[0], y: coordinates[1] });
      return Reflect.apply(original, this, [source, ...coordinates]);
    };
  });
});
test('think/talk/review: cuadros reales en cuatro cámaras y snapshot intacto', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const snapshot = await page.getByTestId('original-snapshot').textContent();
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 1.');
  await page.getByRole('button', { name: 'Focus Fixture CEO', exact: true }).click();
  for (const [view, facing] of [['front', 'front'], ['right', 'left'], ['back', 'back'], ['left', 'right']]) {
    await page.locator('#crew-view').selectOption(view);
    await page.getByRole('button', { name: 'Focus Fixture CEO', exact: true }).click();
    for (const [clip, status] of [['think', 'THINKING'], ['talk', 'CHATTING'], ['review', 'REVIEWING']] as const) {
      await page.evaluate((patch: DesktopPatch) => { window.__gestureDraws = []; window.__crewDesktopFixture(patch); }, { status });
      const expected = catalog.clips.find(item => item.clip === clip && item.facing === facing)!.frames.map(frame => `${frame.x}:${frame.y}`).sort();
      await expect.poll(() => page.evaluate(action => [...new Set(window.__gestureDraws.filter(draw => draw.url.includes(`ceo-${action}-`)).map(draw => `${draw.x}:${draw.y}`))].sort(), clip)).toEqual(expected);
      await page.screenshot({ path: info.outputPath(`${clip}-${view}.png`) });
    }
  }
  expect(await page.getByTestId('original-snapshot').textContent()).toBe(snapshot);
  expect(errors).toEqual([]);
});
test('cancela al salir del estado/sala, movimiento reducido y fallback ES/EN', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => window.__crewDesktopFixture({ status: 'THINKING' }));
  await expect.poll(() => page.evaluate(() => window.__gestureDraws.length)).toBeGreaterThan(2);
  await page.evaluate(() => window.__crewDesktopFixture({ status: 'IDLE' }));
  await page.waitForTimeout(100);
  const idle = await page.evaluate(() => window.__gestureDraws.length);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__gestureDraws.length)).toBe(idle);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.__crewDesktopFixture({ status: 'REVIEWING' }));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__gestureDraws.length)).toBe(idle);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(() => window.__gestureDraws.length)).toBeGreaterThan(idle);
  await page.locator('#crew-room').selectOption('development');
  await page.waitForTimeout(100);
  const empty = await page.evaluate(() => window.__gestureDraws.length);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__gestureDraws.length)).toBe(empty);
  await page.route('**/ceo-talk-v1.png', route => route.abort());
  await page.locator('#crew-room').selectOption('ceo');
  await page.evaluate(() => window.__crewDesktopFixture({ status: 'CHATTING' }));
  await expect(page.getByTestId('crew-action-fallback')).toContainText('Actor animation unavailable');
  await page.evaluate(() => window.__crewDesktopFixture({ locale: 'es' }));
  await expect(page.getByTestId('crew-action-fallback')).toContainText('Animación del personaje no disponible');
  await page.evaluate(() => window.__crewDesktopFixture({ mounted: false }));
  await expect(page.locator('canvas')).toHaveCount(0);
});

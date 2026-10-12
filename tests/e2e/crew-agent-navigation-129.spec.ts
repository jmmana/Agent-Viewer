import { expect, test } from '@playwright/test';
import type { FixturePatch } from './fixtures/crew-walk';

// Named distinctly from crew-walk.spec.ts's own __walkDraws/WalkDraw: both files
// augment the same global `Window`, and a `declare global` block is merged
// project-wide by TypeScript, so two different shapes under the same name would
// be a real type error, not just a same-file naming clash.
interface CrewNavDraw { sx: number; sy: number; destX: number; destY: number }
declare global {
  interface Window { __crewNavDraws: CrewNavDraw[]; __crewWalkFixture: (patch: FixturePatch) => void }
}

const url = '/tests/e2e/fixtures/crew-walk.html?room=development&workspace=development&walking=false';

/**
 * Real local walking (#129): the single CEO fixture agent rests far from the
 * Development room's only door, then walks there once `isWalking` flips true.
 * Verified against src/crew/crewAgentNavigation.ts's own planCrewWalkWithinRoom:
 * the real path from the resting slot (8.75, 2.75) to the arrival slot
 * (0.75, 9.25) goes left along the top wall, clear above dev-desk-1 (3, 4),
 * then straight down along x=1.75, clear of its (2.25-3.75, 3.55-4.45)
 * footprint, taking about 5.9s at CREW_WALK_SPEED. This spec drives the real
 * CrewStage canvas (no mocked renderer) and reads actual drawImage calls,
 * the same technique tests/e2e/crew-walk.spec.ts already uses for frame
 * counting, applied here to the sprite's destination (screen) position
 * instead of its source (sprite-sheet) frame.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__crewNavDraws = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source: CanvasImageSource, ...coordinates: number[]) {
      const image = source as HTMLImageElement;
      if (image.src?.includes('ceo-walk-')) window.__crewNavDraws.push({ sx: coordinates[0], sy: coordinates[1], destX: coordinates[5], destY: coordinates[6] });
      return Reflect.apply(original, this, [source, ...coordinates]);
    };
  });
});

/**
 * Averages the destination of the most recent `count` walk-sprite draws. One full
 * walk-cycle loop (8 frames) has its own small per-frame anchor bob even while the
 * logical room position is perfectly still, so comparing single instantaneous draws
 * would mistake that bob for motion; averaging a full cycle's worth cancels it out.
 */
async function recentAverageDest(page: import('@playwright/test').Page, count = 8) {
  return page.evaluate(n => {
    const recent = window.__crewNavDraws.slice(-n);
    if (recent.length === 0) return null;
    return { x: recent.reduce((sum, draw) => sum + draw.destX, 0) / recent.length,
      y: recent.reduce((sum, draw) => sum + draw.destY, 0) / recent.length };
  }, count);
}

test('a walking CEO moves across three real, distinct screen regions instead of a fixed spot', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForTimeout(300);
  // Resting: the idle pose is drawn, never the walk-cycle sprite.
  expect(await page.evaluate(() => window.__crewNavDraws.length)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('resting.png') });

  await page.evaluate(() => window.__crewWalkFixture({ walking: true }));
  await expect.poll(() => page.evaluate(() => window.__crewNavDraws.length), { timeout: 2_000 }).toBeGreaterThan(8);
  const start = (await recentAverageDest(page))!;
  await page.screenshot({ path: testInfo.outputPath('mid-start.png') });

  // Somewhere around halfway through the ~5.9s walk, the sprite must have moved
  // a real screen distance away from where it started (not replayed in place).
  await expect.poll(async () => {
    const point = await recentAverageDest(page);
    return point ? Math.hypot(point.x - start.x, point.y - start.y) : 0;
  }, { timeout: 4_000 }).toBeGreaterThan(30);
  const mid = (await recentAverageDest(page))!;
  await page.screenshot({ path: testInfo.outputPath('mid-progress.png') });

  // It keeps moving (not stuck at the same mid-point) until it settles at the door.
  await expect.poll(async () => {
    const point = await recentAverageDest(page);
    return point ? Math.hypot(point.x - mid.x, point.y - mid.y) : 0;
  }, { timeout: 5_000 }).toBeGreaterThan(30);

  // The whole ~5.9s walk (CREW_WALK_SPEED over the real furniture-avoiding path) must be
  // over well before this point; two samples a second apart should now be the same place.
  await page.waitForTimeout(7_000);
  const afterMid = (await recentAverageDest(page))!;
  await page.waitForTimeout(1_000);
  const settled = (await recentAverageDest(page))!;
  // Arrived: the averaged position stops drifting even though isWalking is still true in the fixture.
  expect(Math.hypot(settled.x - afterMid.x, settled.y - afterMid.y)).toBeLessThan(10);
  await page.screenshot({ path: testInfo.outputPath('arrived.png') });

  expect(errors).toEqual([]);
});

test('toggling back to resting mid-walk cancels the animation instead of continuing it', async ({ page }) => {
  await page.goto(url);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__crewWalkFixture({ walking: true }));
  await page.waitForTimeout(1_500); // partial progress through the ~5.9s walk, never near the door yet
  const midFlight = await page.evaluate(() => {
    const draw = window.__crewNavDraws.at(-1);
    return draw ? { x: draw.destX, y: draw.destY } : null;
  });
  const drawsBeforeCancel = await page.evaluate(() => window.__crewNavDraws.length);
  await page.evaluate(() => window.__crewWalkFixture({ walking: false }));
  // A handful of already-scheduled animation frames may still land right after the
  // toggle, before React re-renders with isWalking false; give that in-flight settling
  // a moment, then confirm draws stay flat well past it (never resumes/keeps walking).
  await page.waitForTimeout(400);
  const drawsSoonAfterCancel = await page.evaluate(() => window.__crewNavDraws.length);
  await page.waitForTimeout(800);
  const drawsAfterCancel = await page.evaluate(() => window.__crewNavDraws.length);
  expect(midFlight).not.toBeNull();
  expect(drawsSoonAfterCancel - drawsBeforeCancel).toBeLessThan(10);
  expect(drawsAfterCancel).toBe(drawsSoonAfterCancel);
});

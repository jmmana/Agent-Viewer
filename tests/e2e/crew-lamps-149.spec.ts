import { expect, test } from '@playwright/test';
import { CREW_LAMPS_BY_ROOM, crewLampVisible } from '../../src/crew/crewLamps';
import { crewLampScreenPoint } from '../../src/crew/crewLampHitTest';
import { defaultCrewCamera } from '../../src/crew/crewCamera';
import { CREW_ROOMS } from '../../src/crew/crewModel';

const ceo = CREW_ROOMS.find(room => room.id === 'ceo')!;
const camera = defaultCrewCamera();
// The lamp panel only lists fixtures visible from the active camera (cutaway walls hide the rest).
const visibleCeoLamps = CREW_LAMPS_BY_ROOM.ceo.filter(lamp => crewLampVisible(lamp, ceo, camera.view));

test('clicking a lamp on the canvas toggles it, a global switch lights the office, and state persists per room', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await page.locator('#crew-room').selectOption('ceo');
  // Open the lamps panel FIRST: it sits above the canvas in the layout, so opening it
  // after measuring the canvas would shift the canvas down and stale any click coordinate.
  await page.getByText('Office lights', { exact: true }).click();
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Crew canvas has no layout box');
  const deskLamp = CREW_LAMPS_BY_ROOM.ceo.find(lamp => lamp.kind === 'desk')!;
  const point = crewLampScreenPoint(deskLamp, ceo, camera, { width: box.width, height: box.height });
  const lampButton = page.getByTestId(`crew-lamp-${deskLamp.id}`);

  // Day ambience, no manual override yet: auto resolves to off.
  await expect(lampButton).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.click(box.x + point.x, box.y + point.y);
  await expect(lampButton).toHaveAttribute('aria-pressed', 'true');
  await expect(lampButton).toContainText('On');
  await page.screenshot({ path: testInfo.outputPath('ceo-desk-lamp-on.png') });

  // Clicking the same spot again cycles the manual mode forward (on -> off).
  await page.mouse.click(box.x + point.x, box.y + point.y);
  await expect(lampButton).toHaveAttribute('aria-pressed', 'false');
  await expect(lampButton).toContainText('Off');

  // Keyboard-reachable equivalent: the accessible button, then the room-global switches.
  // The lamp is currently 'off'; the three-state cycle (auto -> on -> off -> auto) needs
  // two presses to reach 'on' again, resolving through 'auto' (still off in day ambience).
  await lampButton.focus();
  await page.keyboard.press('Enter');
  await expect(lampButton).toContainText('Auto');
  await expect(lampButton).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(lampButton).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('crew-lamps-all-off').click();
  for (const lamp of visibleCeoLamps) await expect(page.getByTestId(`crew-lamp-${lamp.id}`)).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('crew-lamps-all-on').click();
  for (const lamp of visibleCeoLamps) await expect(page.getByTestId(`crew-lamp-${lamp.id}`)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('ceo-all-lamps-on.png') });

  // A drag (pan gesture) over the same point must never toggle a light.
  await page.getByTestId('crew-lamps-all-off').click();
  await page.mouse.move(box.x + point.x, box.y + point.y);
  await page.mouse.down();
  await page.mouse.move(box.x + point.x + 60, box.y + point.y, { steps: 5 });
  await page.mouse.up();
  await expect(lampButton).toHaveAttribute('aria-pressed', 'false');

  // Switching office never carries lamp state over, and Cartoon never sees the Crew controls.
  await page.locator('#crew-room').selectOption('development');
  await expect(page.getByTestId('crew-lamp-dev-desk-1-lamp')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#crew-room').selectOption('ceo');
  await page.getByTestId('crew-lamps-all-on').click();
  await page.getByRole('button', { name: 'Cartoon', exact: true }).click();
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId('crew-lamps-all-on')).toHaveCount(0);
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await expect(page.getByTestId(`crew-lamp-${deskLamp.id}`)).toHaveAttribute('aria-pressed', 'true');

  // Reload keeps the manual lamp state for this office, same as camera and ambience.
  await page.reload();
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await page.getByText('Office lights', { exact: true }).click();
  await expect(page.getByTestId(`crew-lamp-${deskLamp.id}`)).toHaveAttribute('aria-pressed', 'true');

  expect(errors).toEqual([]);
});

test('night auto-lights the office without a manual switch, and camera zoom/pan never move a light', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await page.locator('#crew-room').selectOption('ceo');
  await page.locator('#crew-ambience').selectOption('night');
  await page.getByText('Office lights', { exact: true }).click();
  const deskLamp = CREW_LAMPS_BY_ROOM.ceo.find(lamp => lamp.kind === 'desk')!;
  const lampButton = page.getByTestId(`crew-lamp-${deskLamp.id}`);
  await expect(lampButton).toHaveAttribute('aria-pressed', 'true');
  await expect(lampButton).toContainText('Auto');
  await page.screenshot({ path: testInfo.outputPath('ceo-night-auto.png') });
  const canvas = page.locator('canvas');
  await canvas.focus();
  await page.keyboard.press('+');
  await page.keyboard.press('ArrowRight');
  await expect(lampButton).toHaveAttribute('aria-pressed', 'true');

  // Switching back to day turns the automatic lamp off again, with no manual override.
  await page.locator('#crew-ambience').selectOption('day');
  await expect(lampButton).toHaveAttribute('aria-pressed', 'false');
});

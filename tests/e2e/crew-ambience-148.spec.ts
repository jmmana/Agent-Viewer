import { expect, test } from '@playwright/test';

for (const mobile of [false, true]) {
  test(`room ambience, persistence, cameras and Cartoon (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
    await page.locator('#crew-room').selectOption('ceo');
    await page.locator('#crew-ambience').selectOption('night');
    const canvas = page.locator('canvas');
    await expect(canvas).toHaveAttribute('data-crew-ambience', 'night');
    const backgroundPixel = () => canvas.evaluate(node => Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(1, 1, 1, 1).data));
    await expect.poll(backgroundPixel).toEqual([16, 27, 48, 255]);
    for (const view of ['front', 'right', 'back', 'left']) {
      await page.locator('#crew-view').selectOption(view);
      await canvas.scrollIntoViewIfNeeded();
      await expect(canvas).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`night-${view}.png`) });
    }
    await page.locator('#crew-room').selectOption('development');
    await expect(page.locator('#crew-ambience')).toHaveValue('day');
    await expect(canvas).toHaveAttribute('data-crew-ambience', 'day');
    await expect.poll(backgroundPixel).toEqual([20, 35, 57, 255]);
    await page.locator('#crew-ambience').selectOption('sunset');
    await canvas.focus();
    await page.keyboard.press('+');
    await page.keyboard.press('ArrowRight');
    await page.screenshot({ path: testInfo.outputPath('development-sunset.png') });
    await page.locator('#crew-room').selectOption('ceo');
    await expect(page.locator('#crew-ambience')).toHaveValue('night');
    await page.getByRole('button', { name: 'Cartoon', exact: true }).click();
    await expect(canvas).toBeVisible();
    await expect(page.locator('#crew-ambience')).toHaveCount(0);
    await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
    await expect(page.locator('#crew-ambience')).toHaveValue('night');
    await page.reload();
    await expect(page.locator('#crew-ambience')).toHaveValue('night');
    await page.locator('#crew-room').selectOption('development');
    await expect(page.locator('#crew-ambience')).toHaveValue('sunset');
    await page.getByText('Crew accessibility and audio', { exact: true }).click();
    await page.locator('#crew-high-contrast').check();
    await canvas.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('high-contrast.png') });
    expect(errors).toEqual([]);
  });
}

test('automatic ambience follows local clock without overriding a manual room', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 9, 12, 7, 59, 50) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await page.locator('#crew-ambience').selectOption('auto');
  await expect(page.locator('canvas')).toHaveAttribute('data-crew-ambience', 'dawn');
  await page.clock.fastForward(30_000);
  await expect(page.locator('canvas')).toHaveAttribute('data-crew-ambience', 'day');
  await page.locator('#crew-ambience').selectOption('night');
  await page.clock.fastForward(60_000);
  await expect(page.locator('canvas')).toHaveAttribute('data-crew-ambience', 'night');
});

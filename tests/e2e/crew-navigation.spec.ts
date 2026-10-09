import { expect, test } from '@playwright/test';

test('restaura modo, sala y cámara al recargar y al regresar desde Caricatura', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await page.locator('#crew-room').selectOption('development');
  await page.locator('#crew-view').selectOption('back');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const cameras = await page.evaluate(() => localStorage.getItem('agent-viewer-crew-camera-v1'));
  await page.reload();
  await expect(page.locator('#crew-room')).toHaveValue('development');
  await expect(page.locator('#crew-view')).toHaveValue('back');
  await expect(page.getByText('120%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cartoon', exact: true }).click();
  await page.reload();
  await expect(page.locator('#crew-room')).toHaveCount(0);
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await expect(page.locator('#crew-room')).toHaveValue('development');
  expect(await page.evaluate(() => localStorage.getItem('agent-viewer-crew-camera-v1'))).toBe(cameras);
});

test('una sala eliminada usa CEO sin pantalla vacía', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agent-viewer-crew-navigation-v1', JSON.stringify({
    version: 1, selectedMode: 'crew', selectedRoomId: 'deleted-office',
  })));
  await page.goto('/');
  await expect(page.locator('#crew-room')).toHaveValue('ceo');
  await expect(page.locator('canvas')).toBeVisible();
});

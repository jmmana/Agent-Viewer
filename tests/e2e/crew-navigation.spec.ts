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

test('enlace directo, aviso de sala inexistente y reset sin perder consumo', async ({page}) => {
  await page.goto('/?visualMode=crew&crewRoom=development');
  await expect(page.locator('#crew-room')).toHaveValue('development');
  await page.locator('#crew-view').selectOption('right');
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  const usage = await page.getByRole('button').filter({hasText:'222.6K'}).innerText();
  await expect(page.getByRole('link',{name:'Link to this office',exact:true})).toHaveAttribute('href','/?visualMode=crew&crewRoom=development');
  await page.getByRole('button',{name:'Reset Crew preferences',exact:true}).click();
  await expect(page.locator('#crew-room')).toHaveValue('ceo');
  await expect(page.locator('#crew-view')).toHaveValue('front');
  await expect(page.getByText('100%',{exact:true})).toBeVisible();
  expect(await page.getByRole('button').filter({hasText:'222.6K'}).innerText()).toBe(usage);
  await expect.poll(() => page.evaluate(()=>localStorage.getItem('agent-viewer-crew-camera-v1'))).toBe('{}');
  await page.reload();
  await expect(page.locator('#crew-room')).toHaveValue('ceo');
  await page.goto('/?crewRoom=deleted');
  await expect(page.getByRole('status')).toContainText('linked office is unavailable');
  await expect(page.locator('#crew-room')).toHaveValue('ceo');
  await page.locator('#crew-room').selectOption('development');
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#crew-room')).toHaveValue('development');
});

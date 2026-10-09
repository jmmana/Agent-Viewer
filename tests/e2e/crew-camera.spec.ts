import { expect, test } from '@playwright/test';

const storageKey = 'agent-viewer-crew-camera-v1';

test('cámara aislada, rueda, teclado y regreso desde Caricatura', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  const canvas = page.locator('canvas');
  const camera = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').ceo, storageKey);
  for (const room of ['ceo', 'development']) {
    await page.locator('#crew-room').selectOption(room);
    for (const view of ['front', 'right', 'back', 'left']) {
      await page.locator('#crew-view').selectOption(view);
      await expect(canvas).toBeVisible();
      await expect(page.locator('canvas')).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath(`${room}-${view}.png`) });
    }
  }
  await page.locator('#crew-room').selectOption('ceo');
  await page.getByRole('button', { name: 'Fit room', exact: true }).click();
  await canvas.hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await camera()).zoom).toBeGreaterThan(1);
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('#crew-view').selectOption('right');
  const saved = await camera();
  await page.locator('#crew-room').selectOption('development');
  await page.getByRole('button', { name: 'Fit room', exact: true }).click();
  await page.locator('#crew-room').selectOption('ceo');
  await expect.poll(camera).toEqual(saved);
  await expect(page.locator('#crew-view')).toHaveValue('right');
  await page.getByRole('button', { name: 'Cartoon', exact: true }).click();
  await expect(page.locator('#crew-room')).toHaveCount(0);
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('cartoon-return.png') });
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await expect.poll(camera).toEqual(saved);
  await canvas.focus();
  await page.keyboard.press('Home');
  await expect.poll(camera).toEqual({view:'front',zoom:1,pan:{x:0,y:0}});
  expect(errors).toEqual([]);
});

test('pinch táctil real a 320px y cancelación sin contaminar otra sala', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  const canvas = page.locator('canvas');
  const bounds = (await canvas.boundingBox())!;
  expect(bounds.width).toBe(320);
  const session = await context.newCDPSession(page);
  const y = bounds.y + bounds.height / 2;
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: {x:number;y:number;id:number}[]) => {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  };
  await touch('touchStart', [{x:110,y,id:1},{x:210,y,id:2}]);
  await touch('touchMove', [{x:70,y,id:1},{x:250,y,id:2}]);
  const camera = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').ceo, storageKey);
  await expect.poll(async () => (await camera()).zoom).toBeGreaterThan(1.5);
  await touch('touchCancel', []);
  await page.screenshot({path:testInfo.outputPath('mobile-pinch.png')});
  const saved = await camera();
  await page.locator('#crew-room').selectOption('development');
  await touch('touchStart', [{x:100,y,id:3}]);
  await touch('touchMove', [{x:130,y:y+20,id:3}]);
  await touch('touchEnd', []);
  await expect.poll(camera).toEqual(saved);
  await page.locator('#crew-room').selectOption('ceo');
  await expect.poll(camera).toEqual(saved);
  await context.close();
});

test('enfoca escritorios y limita paneo incluso tras reducir el viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({width:1920,height:1080});
  await page.goto('/');
  await page.getByRole('button', {name:'Crew · Beta',exact:true}).click();
  await page.locator('#crew-focus').selectOption('ceo-desk');
  await expect(page.getByText('150%',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('ceo-desk-focus.png')});
  const canvas = page.locator('canvas');
  await canvas.focus();
  for (let i=0;i<50;i++) await page.keyboard.press('ArrowRight');
  await page.setViewportSize({width:320,height:800});
  await expect.poll(async () => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').ceo.pan.x, storageKey)).toBeLessThanOrEqual(128);
  await page.locator('#crew-room').selectOption('development');
  await expect(page.locator('#crew-focus option[value="ceo-desk"]')).toHaveCount(0);
  await page.locator('#crew-focus').selectOption('dev-display');
  await expect(page.getByText('150%',{exact:true})).toBeVisible();
});

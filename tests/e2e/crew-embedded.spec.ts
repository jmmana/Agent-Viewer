import { expect, test } from '@playwright/test';

test('dos oficinas embebidas controladas conservan cámaras sin almacenamiento global', async ({page}, testInfo) => {
  await page.goto('/tests/e2e/fixtures/crew-embedded.html');
  const one = page.getByTestId('Equipo uno'), two = page.getByTestId('Equipo dos');
  await one.getByRole('combobox',{name:'Oficina',exact:true}).selectOption('development');
  await one.getByRole('combobox',{name:'Cámara',exact:true}).selectOption('right');
  await one.getByRole('button',{name:'Acercar',exact:true}).click();
  await expect(one.getByText('120%',{exact:true})).toBeVisible();
  await expect(two.getByText('100%',{exact:true})).toBeVisible();
  await expect(two.getByRole('combobox',{name:'Oficina',exact:true})).toHaveValue('ceo');
  await one.getByRole('button',{name:'Cambiar modo',exact:true}).click();
  await expect(one.getByRole('combobox',{name:'Oficina',exact:true})).toHaveCount(0);
  await one.getByRole('button',{name:'Cambiar modo',exact:true}).click();
  await expect(one.getByRole('combobox',{name:'Oficina',exact:true})).toHaveValue('development');
  await expect(one.getByRole('combobox',{name:'Cámara',exact:true})).toHaveValue('right');
  await expect(one.getByText('120%',{exact:true})).toBeVisible();
  await expect(one.getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('agent-viewer-crew')))).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('embedded-two-offices.png')});
  await page.setViewportSize({width:390,height:844});
  await one.locator('canvas').scrollIntoViewIfNeeded();
  await expect.poll(()=>one.locator('canvas').evaluate(canvas=>{
    const rect=canvas.getBoundingClientRect();
    return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===canvas;
  })).toBe(true);
  await page.screenshot({path:testInfo.outputPath('embedded-mobile.png')});
});

import { expect, test } from '@playwright/test';

// Eventos sintéticos, incluidos actores en oficinas ajenas. No contienen datos de clientes.
const events = [
  ['dev-fixture', 'agent.registered', {name:'Catalog Developer',workspace:'development'}],
  ['qa-fixture', 'agent.registered', {name:'Catalog Reviewer',workspace:'qa_lab'}],
  ['boss-fixture', 'agent.registered', {name:'Catalog CEO',workspace:'boss_office',role:'boss'}],
  ['qa-fixture', 'agent.status.changed', {status:'TESTING'}],
  ['qa-fixture', 'llm.usage', {provider:'fixture',model:'fixture',inputTokens:1234,outputTokens:0,cost:.12,costSource:'provider-reported',currency:'USD'}],
].map(([agentId,type,payload],index) => ({schemaVersion:'1.0',id:`catalog-${index}`,agentId,type,payload,
  timestamp:Date.UTC(2026,0,1)+index,source:'catalog-fixture',severity:'normal',summary:'Synthetic catalog evidence'}));

test('catálogo aislado, búsqueda, cambios rápidos y conservación con eventos de otras salas', async ({page}, testInfo) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/v1/events/stream*',route => route.fulfill({contentType:'text/event-stream',
    body:events.map(event=>`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`).join('')}));
  await page.goto('/?mode=live&visualMode=crew&crewRoom=development');
  const region = page.getByRole('region',{name:'Crew mode: independent office'});
  await expect(region.getByText('Catalog Developer: IDLE',{exact:true})).toBeVisible();
  await expect(region.getByRole('button',{name:'Focus Catalog Reviewer',exact:true})).toHaveCount(0);
  await expect(region.getByRole('button',{name:'Focus Catalog CEO',exact:true})).toHaveCount(0);
  await expect(page.getByText('$0.120',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('catalog-desktop.png')});
  const search = page.getByRole('searchbox',{name:'Search offices'});
  await search.fill('finanzas');
  await expect(page.locator('#crew-room option')).toHaveCount(2);
  await page.locator('#crew-room').selectOption('finance');
  await expect(region.getByText('Empty office. Furniture remains visible.',{exact:true})).toBeVisible();
  await search.fill('missing-office');
  await expect(page.locator('#crew-room')).toHaveValue('finance');
  await expect(region.getByText('No matches. The active office stays selected.',{exact:true})).toBeVisible();
  await search.fill('');
  for (const id of ['ceo','qa','development','reception','development']) await page.locator('#crew-room').selectOption(id);
  await page.reload();
  await expect(page.locator('#crew-room')).toHaveValue('development');
  await page.locator('#crew-room').selectOption('qa');
  await expect(region.getByText('Catalog Reviewer: TESTING',{exact:true})).toBeVisible();
  await expect(page.getByText('$0.120',{exact:true})).toBeVisible();
  await page.locator('#crew-room').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#crew-room')).toHaveValue('finance');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#crew-room')).toHaveValue('qa');
  await page.setViewportSize({width:320,height:900});
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('es');
  await page.getByRole('searchbox',{name:'Buscar oficina'}).fill('investigacion');
  await page.locator('#crew-room').selectOption('research');
  await expect(page.getByText('Oficina vacía. El mobiliario sigue disponible.',{exact:true})).toBeVisible();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate(element=>{
    const r=element.getBoundingClientRect();
    return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===element;
  })).toBe(true);
  await page.screenshot({path:testInfo.outputPath('catalog-mobile.png')});
});

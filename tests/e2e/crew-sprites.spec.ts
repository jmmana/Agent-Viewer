import { expect, test } from '@playwright/test';

const event = {schemaVersion:'1.0', id:'sprite-ceo', type:'agent.registered', timestamp:Date.UTC(2026,0,1),
  source:'agent:fixture', agentId:'sprite-ceo', summary:'Synthetic CEO fixture',
  payload:{name:'Fixture CEO',role:'boss',workspace:'boss_office'}};

test('CEO estático en cuatro vistas, carga aislada por sala y regreso a Caricatura', async ({page}, info) => {
  const images:string[]=[];
  page.on('request',request=>{if(request.resourceType()==='image' && request.url().includes('/bank/characters/')) images.push(request.url());});
  await page.addInitScript(() => {
    const original=CanvasRenderingContext2D.prototype.drawImage;
    (window as any).__crewDrawn=[];
    CanvasRenderingContext2D.prototype.drawImage=function(...args:any[]) {
      const source=args[0] as HTMLImageElement;
      if(source.src?.includes('/bank/characters/')) (window as any).__crewDrawn.push(source.src);
      return original.apply(this,args as any);
    };
  });
  await page.route('**/api/v1/events/stream*',route=>route.fulfill({contentType:'text/event-stream',
    body:`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`}));
  await page.goto('/?mode=live&visualMode=crew&crewRoom=development');
  await expect(page.getByTestId('crew-art-status')).toHaveText('Illustrations: 0.');
  expect(images).toEqual([]);
  await page.locator('#crew-room').selectOption('ceo');
  for(const view of ['front','right','back','left']) {
    await page.locator('#crew-view').selectOption(view);
    await expect(page.getByTestId('crew-art-status')).toHaveText('Illustrations: 1.');
    const facing = {front:'front',right:'left',back:'back',left:'right'}[view];
    await expect.poll(()=>page.evaluate(v=>(window as any).__crewDrawn.some((url:string)=>url.includes(`idle-${v}.png`)),facing)).toBe(true);
    await page.screenshot({path:info.outputPath(`ceo-${view}.png`)});
  }
  expect(new Set(images.map(url=>url.split('/').at(-1)))).toEqual(new Set(['idle-front.png','idle-right.png','idle-back.png','idle-left.png']));
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:info.outputPath('ceo-mobile.png')});
  await page.locator('#crew-room').selectOption('development');
  await expect(page.getByTestId('crew-art-status')).toHaveText('Illustrations: 0.');
  await page.getByRole('button',{name:'Cartoon',exact:true}).click();
  await expect(page.getByTestId('crew-art-status')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(1);
});

test('un PNG no disponible conserva el agente y su marcador',async({page})=>{
  await page.route('**/idle-front.png',route=>route.abort());
  await page.route('**/api/v1/events/stream*',route=>route.fulfill({contentType:'text/event-stream',
    body:`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`}));
  await page.goto('/?mode=live&visualMode=crew&crewRoom=ceo');
  await expect(page.getByTestId('crew-art-status')).toContainText('Image unavailable; the marker remains visible.');
  await expect(page.getByRole('button',{name:'Focus Fixture CEO',exact:true})).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
});

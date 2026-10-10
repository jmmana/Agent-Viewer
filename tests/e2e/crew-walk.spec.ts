import {test,expect} from '@playwright/test';
import type {FixturePatch} from './fixtures/crew-walk';

type Draw={url:string;x:number;y:number};
declare global {interface Window {__walkDraws:Draw[];__crewWalkFixture:(patch:FixturePatch)=>void}}
const url='/tests/e2e/fixtures/crew-walk.html';
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{
    window.__walkDraws=[];
    const original=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(source:CanvasImageSource,...coordinates:number[]){
      const image=source as HTMLImageElement;
      if(image.src?.includes('ceo-walk-')) window.__walkDraws.push({url:image.src,x:coordinates[0],y:coordinates[1]});
      return Reflect.apply(original,this,[source,...coordinates]);
    };
  });
});

test('reproduce ocho cuadros reales en cuatro cámaras, móvil y zoom, sin cambiar el snapshot',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const requests:string[]=[];page.on('request',request=>{if(request.url().includes('ceo-walk-') && request.url().endsWith('.png'))requests.push(request.url());});
  await page.goto(url);
  const snapshot=await page.getByTestId('original-snapshot').textContent();
  await expect(page.getByRole('heading')).toHaveText('DEMO: synthetic read-only CEO transit snapshot.');
  const facings=['front','left','back','right'];
  for(const [index,view] of ['front','right','back','left'].entries()) {
    await page.locator('#crew-view').selectOption(view);
    const facing=facings[index];
    await expect.poll(()=>page.evaluate(direction=>new Set(window.__walkDraws.filter(draw=>draw.url.includes(`ceo-walk-${direction}-`)).map(draw=>`${draw.x}:${draw.y}`)).size,facing)).toBe(8);
    await page.getByRole('button',{name:'Focus Fixture CEO',exact:true}).click();
    await page.waitForTimeout(1100);
    await page.screenshot({path:info.outputPath(`walk-${facing}.png`)});
    expect(await page.getByTestId('original-snapshot').textContent()).toBe(snapshot);
  }
  expect(new Set(requests.map(request=>request.split('/').at(-1))).size).toBe(4);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.__crewWalkFixture({locale:'es'}));
  await page.screenshot({path:info.outputPath('walk-mobile-es.png')});
  await page.setViewportSize({width:1920,height:900});
  await page.locator('#crew-view').selectOption('front');
  for(let index=0;index<5;index++)await page.getByRole('button',{name:'Acercar',exact:true}).click();
  await page.getByRole('button',{name:'Enfocar a Fixture CEO',exact:true}).click();
  await expect(page.getByText('300%',{exact:true})).toBeVisible();
  await page.waitForTimeout(1100);
  await page.screenshot({path:info.outputPath('walk-zoom.png')});
  for(let index=0;index<12;index++)await page.getByRole('button',{name:'Alejar',exact:true}).click();
  await expect(page.getByText('50%',{exact:true})).toBeVisible();
  await page.waitForTimeout(1100);
  await page.screenshot({path:info.outputPath('walk-zoom-min.png')});
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(150);
  const count=await page.evaluate(()=>window.__walkDraws.length);await page.waitForTimeout(350);
  expect(await page.evaluate(()=>window.__walkDraws.length)).toBe(count);
  await page.screenshot({path:info.outputPath('walk-reduced-motion.png')});
  await page.evaluate(()=>window.__crewWalkFixture({mounted:false}));
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('carga solo caminar reportado para CEO presente y cancela al salir de sala',async({page})=>{
  await page.goto(url);await expect.poll(()=>page.evaluate(()=>window.__walkDraws.length)).toBeGreaterThan(0);
  await page.evaluate(()=>window.__crewWalkFixture({walking:false}));await page.waitForTimeout(150);
  const before=await page.evaluate(()=>window.__walkDraws.length);await page.waitForTimeout(350);
  expect(await page.evaluate(()=>window.__walkDraws.length)).toBe(before);
  await page.evaluate(()=>window.__crewWalkFixture({walking:true}));await expect.poll(()=>page.evaluate(()=>window.__walkDraws.length)).toBeGreaterThan(before);
  await page.locator('#crew-room').selectOption('development');await page.waitForTimeout(150);
  const empty=await page.evaluate(()=>window.__walkDraws.length);await page.waitForTimeout(350);
  expect(await page.evaluate(()=>window.__walkDraws.length)).toBe(empty);
  await page.reload();await page.evaluate(()=>window.__crewWalkFixture({role:'backend_engineer'}));await page.waitForTimeout(150);
  const other=await page.evaluate(()=>window.__walkDraws.length);await page.waitForTimeout(350);
  expect(await page.evaluate(()=>window.__walkDraws.length)).toBe(other);
});

test('atlas ausente conserva sprite y aviso en ambos idiomas',async({page})=>{
  await page.route('**/ceo-walk-front-v1.png',route=>route.abort());await page.goto(url);
  await expect(page.getByTestId('crew-walk-fallback')).toHaveText('Walk atlas unavailable; the original pose remains visible.');
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 1.');
  expect(await page.evaluate(()=>window.__walkDraws.length)).toBe(0);
  await page.evaluate(()=>window.__crewWalkFixture({locale:'es'}));
  await expect(page.getByTestId('crew-walk-fallback')).toHaveText('Atlas de caminar no disponible; se conserva la pose original.');
});

test('reducir movimiento antes de entrar evita descargar cualquier atlas',async({page})=>{
  const downloads:string[]=[];page.on('request',request=>{if(request.url().includes('ceo-walk-')&&request.url().endsWith('.png'))downloads.push(request.url());});
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(url);
  await expect(page.getByTestId('crew-art-status')).toContainText('Illustrations: 1.');
  await page.locator('#crew-view').selectOption('back');await page.waitForTimeout(200);
  expect(downloads).toEqual([]);expect(await page.evaluate(()=>window.__walkDraws)).toEqual([]);
});

test('no descarga atlas para reposo, otros roles ni salas sin CEO',async({page})=>{
  const requests:string[]=[];page.on('request',request=>{if(request.url().includes('ceo-walk-')&&request.url().endsWith('.png'))requests.push(request.url());});
  for(const query of ['walking=false','role=other','room=development']) {
    await page.goto(`${url}?${query}`);
    await expect(page.locator('canvas')).toHaveCount(1);await page.waitForTimeout(250);
    expect(requests).toEqual([]);expect(await page.evaluate(()=>window.__walkDraws)).toEqual([]);
  }
});

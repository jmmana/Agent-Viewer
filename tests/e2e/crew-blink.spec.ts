import { expect, test } from '@playwright/test';

const event={schemaVersion:'1.0',id:'blink-fixture',type:'agent.registered',timestamp:Date.UTC(2026,0,1),
  source:'agent:fixture',agentId:'blink-fixture',summary:'Synthetic blink fixture',
  payload:{name:'Blink Fixture CEO',role:'boss',workspace:'boss_office'}};

test('reproduce expresiones distintas y respeta movimiento reducido en runtime Crew',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    (window as any).__blinkFrames=[];
    const draw=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(...args:any[]) {
      if((args[0] as HTMLImageElement).src?.includes('ceo-blink-front-v1'))
        (window as any).__blinkFrames.push([args[1],args[2]]);
      return draw.apply(this,args as any);
    };
  });
  await page.route('**/api/v1/events/stream*',route=>route.fulfill({contentType:'text/event-stream',
    body:`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`}));
  await page.goto('/?mode=live&visualMode=crew&crewRoom=ceo');
  await expect.poll(()=>page.evaluate(()=>new Set((window as any).__blinkFrames.map(JSON.stringify)).size),{timeout:8000}).toBe(4);
  await page.getByRole('button',{name:'Focus Blink Fixture CEO',exact:true}).click();
  await page.screenshot({path:info.outputPath('ceo-blink.png')});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForTimeout(100);
  const before=await page.evaluate(()=>(window as any).__blinkFrames.length);
  await page.waitForTimeout(400);
  expect(await page.evaluate(()=>(window as any).__blinkFrames.length)).toBe(before);
  await page.reload();
  await expect(page.getByTestId('crew-art-status')).toHaveText('Illustrations: 1.');
  expect(await page.evaluate(()=>(window as any).__blinkFrames)).toEqual([]);
  await page.getByRole('button',{name:'Cartoon',exact:true}).click();
  await expect(page.getByTestId('crew-art-status')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('un atlas ausente mantiene la pose original sin perder el agente',async({page})=>{
  await page.route('**/ceo-blink-front-v1.png',route=>route.abort());
  await page.route('**/api/v1/events/stream*',route=>route.fulfill({contentType:'text/event-stream',
    body:`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`}));
  await page.goto('/?mode=live&visualMode=crew&crewRoom=ceo');
  await expect(page.getByTestId('crew-art-status')).toHaveText('Illustrations: 1.');
  await expect(page.getByRole('button',{name:'Focus Blink Fixture CEO',exact:true})).toBeVisible();
  await page.locator('#crew-view').selectOption('back');
  await expect(page.getByTestId('crew-art-status')).toHaveText('Illustrations: 1.');
});

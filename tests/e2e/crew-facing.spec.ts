import {expect,test} from '@playwright/test';

test('cuatro CEO mantienen orientación individual al rotar la cámara y recibir otro snapshot',async({page},info)=>{
  await page.setViewportSize({width:1280,height:900});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(()=>{
    (window as any).__byNumber={};
    let last='';
    const draw=CanvasRenderingContext2D.prototype.drawImage;
    const label=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.drawImage=function(...args:any[]){
      last=(args[0] as HTMLImageElement).src?.match(/idle-(front|right|back|left)\.png/)?.[1] ?? '';
      return draw.apply(this,args as any);
    };
    CanvasRenderingContext2D.prototype.fillText=function(...args:any[]){
      if(last && /^[1-4]$/.test(args[0])) (window as any).__byNumber[args[0]]=last;
      return label.apply(this,args as any);
    };
  });
  await page.goto('/tests/e2e/fixtures/crew-facing.html');
  const original=await page.getByTestId('snapshot').textContent();
  await expect(page.getByTestId('crew-art-status')).toHaveText('Ilustraciones: 4.');
  const views=['front','right','back','left'];
  const orientations=['front','left','back','right'];
  for(let camera=0;camera<4;camera++){
    await page.locator('#crew-view').selectOption(views[camera]);
    const expected=Object.fromEntries(views.map((_,index)=>[String(index+1),orientations[(index+camera)%4]]));
    await expect.poll(()=>page.evaluate(()=>(window as any).__byNumber)).toEqual(expected);
    expect(await page.getByTestId('snapshot').textContent()).toBe(original);
    await page.screenshot({path:info.outputPath(`facing-${views[camera]}.png`)});
  }
  await page.getByRole('button',{name:'Girar primer agente',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__byNumber)).toEqual({'1':'front','2':'front','3':'left','4':'back'});
  const changed=JSON.parse((await page.getByTestId('snapshot').textContent())!);
  const before=JSON.parse(original!);
  expect(changed).toEqual(before.map((agent:any,index:number)=>index===0 ? {...agent,facing:'SW'} : agent));
});

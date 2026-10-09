import { expect, test } from '@playwright/test';

// Datos exclusivamente sintéticos del test; no se envían a un servidor ni proveedor.
const events = [
  ['agent.registered', {name:'QA Fixture Developer', workspace:'development'}],
  ['agent.status.changed', {status:'CODING'}],
  ['llm.usage', {provider:'fixture',model:'fixture-model',inputTokens:1000,outputTokens:500,cost:.25,costSource:'provider-reported',currency:'USD'}],
].map(([type,payload],index) => ({
  schemaVersion:'1.0',id:`crew-qa-${index}`,type,timestamp:Date.UTC(2026,0,1)+index,
  source:'agent:crew-qa',agentId:'crew-qa',severity:'normal',summary:'Synthetic QA fixture',payload,
}));

for (const transport of ['sse','log'] as const) {
  test(`conserva presencia y consumo de ${transport} entre salas y modos`, async ({page}) => {
    await page.route('**/api/v1/events/stream*', route => transport === 'sse'
      ? route.fulfill({ contentType:'text/event-stream', headers:{'Access-Control-Allow-Origin':'*'},
        body:events.map(event => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`).join('') })
      : route.abort());
    await page.goto('/?mode=live');
    if (transport === 'log') {
      const dataTransfer = await page.evaluateHandle(lines => {
        const data = new DataTransfer();
        data.items.add(new File([lines], 'synthetic-crew-qa.jsonl', {type:'application/x-ndjson'}));
        return data;
      }, events.map(event=>JSON.stringify(event)).join('\n'));
      await page.locator('#root > div').dispatchEvent('drop', {dataTransfer});
      await dataTransfer.dispose();
    }
    await expect(page.getByText('1.5K',{exact:true})).toBeVisible();
    await expect(page.getByText('$0.250',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Crew · Beta',exact:true}).click();
    const crew = page.getByRole('region',{name:'Crew mode: independent office'});
    await expect(crew.getByText('Agents in this room: 0',{exact:true})).toBeVisible();
    await page.locator('#crew-room').selectOption('development');
    await expect(crew.getByText('QA Fixture Developer: CODING',{exact:true})).toBeVisible();
    await crew.getByRole('button',{name:'Focus QA Fixture Developer',exact:true}).click();
    await expect(crew.getByText('150%',{exact:true})).toBeVisible();
    for (let i=0;i<3;i++) {
      await page.getByRole('button',{name:'Cartoon',exact:true}).click();
      await expect(page.locator('canvas')).toHaveCount(1);
      await page.getByRole('button',{name:'Crew · Beta',exact:true}).click();
      await expect(crew.getByText('QA Fixture Developer: CODING',{exact:true})).toBeVisible();
      await expect(page.getByText('1.5K',{exact:true})).toBeVisible();
      await expect(page.getByText('$0.250',{exact:true})).toBeVisible();
    }
    await page.locator('#crew-room').selectOption('ceo');
    await expect(crew.getByText('Agents in this room: 0',{exact:true})).toBeVisible();
  });
}

test('LIVE sin eventos permanece vacío en todas las salas del catálogo', async ({page}) => {
  await page.route('**/api/v1/events/stream*', route => route.abort());
  await page.goto('/?mode=live');
  await page.getByRole('button',{name:'Crew · Beta',exact:true}).click();
  const ids = await page.locator('#crew-room option').evaluateAll(options => options.map(option=>(option as HTMLOptionElement).value));
  expect(ids).toHaveLength(11);
  for (const id of ids) {
    await page.locator('#crew-room').selectOption(id);
    await expect(page.getByText('Agents in this room: 0',{exact:true})).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(1);
  }
});

test('libera observadores Crew al salir y mantiene controles ES en cuatro tamaños', async ({page}, testInfo) => {
  await page.addInitScript(() => {
    const NativeObserver = window.ResizeObserver;
    const active = new Set<ResizeObserver>();
    window.ResizeObserver = class extends NativeObserver {
      observe(target: Element, options?: ResizeObserverOptions) {
        if (target.tagName === 'CANVAS' && target.closest('section')?.getAttribute('aria-label')?.includes('Crew')) active.add(this);
        super.observe(target, options);
      }
      disconnect() { active.delete(this); super.disconnect(); }
    };
    Object.defineProperty(window, '__crewObserverCount', {get:()=>active.size});
  });
  await page.goto('/');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('es');
  for (const width of [320,390,768,1920]) {
    await page.setViewportSize({width,height:900});
    await page.getByRole('button',{name:'Crew · Beta',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as unknown as {__crewObserverCount:number}).__crewObserverCount)).toBe(1);
    await expect(page.getByRole('button',{name:'Acercar',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Alejar',exact:true})).toBeVisible();
    const bounds = (await page.locator('canvas').boundingBox())!;
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
    // Un canvas con tamaño puede estar tapado por una barra lateral superpuesta.
    await expect.poll(() => page.locator('canvas').evaluate(canvas => {
      const rect = canvas.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === canvas;
    })).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`crew-es-${width}.png`)});
    await page.getByRole('button',{name:'Caricatura',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as unknown as {__crewObserverCount:number}).__crewObserverCount)).toBe(0);
  }
});

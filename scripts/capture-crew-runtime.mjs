import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
await mkdir('test-results/crew-demo', { recursive: true });
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined,headless:true});
const context = await browser.newContext({viewport:{width:1280,height:800},recordVideo:{dir:'test-results/crew-demo',size:{width:1280,height:800}}});
const page = await context.newPage();
await page.goto(process.env.CREW_CAPTURE_URL || 'http://127.0.0.1:3000');
await page.waitForTimeout(700);
await page.getByRole('button',{name:'Crew · Beta',exact:true}).click();
for(const room of ['ceo','development']) {
 await page.locator('#crew-room').selectOption(room);
 for(const view of ['front','right','back','left']) {
  await page.locator('#crew-view').selectOption(view);
  await page.waitForTimeout(600);
 }
 await page.locator('#crew-focus').selectOption(room==='ceo'?'ceo-desk':'dev-desk-1');
 await page.waitForTimeout(800);
 await page.getByRole('button',{name:'Fit room',exact:true}).click();
}
await page.getByRole('button',{name:'Cartoon',exact:true}).click();
await page.waitForTimeout(800);
await page.getByRole('button',{name:'Crew · Beta',exact:true}).click();
await page.reload();
await page.waitForTimeout(800);
const video=page.video();
await context.close();
await video.saveAs('test-results/crew-demo/runtime.webm');
await browser.close();

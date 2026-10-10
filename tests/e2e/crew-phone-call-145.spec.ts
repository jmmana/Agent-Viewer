import { expect, test } from '@playwright/test';

/**
 * #145: aviso de llamada telefónica en Crew, ligado al status REAL `PHONE_CALL` del
 * agente (campo del dominio, no una simulación propia de este test). Datos
 * exclusivamente sintéticos; no se envían a un servidor ni proveedor real.
 */
const events = [
  { agentId: 'ceo-fixture', type: 'agent.registered', payload: { name: 'CEO Fixture', workspace: 'boss_office', role: 'boss' } },
  { agentId: 'dev-fixture', type: 'agent.registered', payload: { name: 'Dev Fixture', workspace: 'development' } },
  { agentId: 'ceo-fixture', type: 'agent.status.changed', payload: { status: 'PHONE_CALL' } },
].map(({ agentId, type, payload }, index) => ({
  schemaVersion: '1.0', id: `crew-call-${index}`, type, timestamp: Date.UTC(2026, 0, 1) + index,
  source: `agent:${agentId}`, agentId, severity: 'normal', summary: 'Synthetic phone call fixture', payload,
}));

async function gotoLiveCrew(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/snapshot', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ lastEventId: null, events: [], agents: [], totalTokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, totalCost: 0 }) }));
  await page.route('**/api/v1/events/stream*', route => route.fulfill({ contentType: 'text/event-stream',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: events.map(event => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`).join('') }));
  await page.goto('/?mode=live');
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  return page.getByRole('region', { name: 'Crew mode: independent office' });
}

test('aviso de llamada: aparece en la sala real, persiste al cambiar de sala y se puede descartar (#145)', async ({ page }) => {
  const crew = await gotoLiveCrew(page);
  // La sala por defecto es Dirección (CEO), donde el fixture coloca al agente en llamada.
  await expect(crew.getByText('CEO Fixture:', { exact: false })).toBeVisible();
  await expect(crew.getByText(/Ringing \d:\d\d|Timbrando \d:\d\d|On call \d:\d\d|En llamada \d:\d\d/)).toBeVisible();
  const dismiss = crew.getByRole('button', { name: /Dismiss call notice|Descartar aviso de llamada/ });
  await expect(dismiss).toBeVisible();

  // Aislamiento entre salas: Desarrollo no muestra ningún aviso de llamada del CEO.
  await page.locator('#crew-room').selectOption('development');
  await expect(crew.getByText('Dev Fixture:', { exact: false })).toBeVisible();
  await expect(crew.getByText(/Ringing|Timbrando|On call|En llamada/)).toHaveCount(0);

  // Cambiar de sala no borra el estado: al volver a Dirección, la llamada real sigue
  // viva (el agente sigue reportando PHONE_CALL) y el cronómetro local sigue mostrando texto.
  await page.locator('#crew-room').selectOption('ceo');
  await expect(crew.getByText(/Ringing \d:\d\d|Timbrando \d:\d\d|On call \d:\d\d|En llamada \d:\d\d/)).toBeVisible();

  // Descartar oculta SOLO el aviso visual local; el status real sigue intacto (no se
  // inventa ni se envía ninguna acción de colgar).
  await dismiss.click();
  await expect(crew.getByText(/Ringing|Timbrando|On call|En llamada/)).toHaveCount(0);
  await expect(crew.getByText('CEO Fixture: PHONE_CALL', { exact: false })).toBeVisible();
});

test('zoom alto/bajo y las cuatro orientaciones de cámara siguen funcionando con el aviso en escena (#145)', async ({ page }) => {
  const crew = await gotoLiveCrew(page);
  await expect(crew.getByText(/Ringing|Timbrando|On call|En llamada/)).toBeVisible();
  const zoomIn = crew.getByRole('button', { name: 'Zoom in', exact: true });
  const zoomOut = crew.getByRole('button', { name: 'Zoom out', exact: true });
  for (let i = 0; i < 4; i++) await zoomIn.click();
  await expect(crew.getByText('207%', { exact: true })).toBeVisible();
  for (let i = 0; i < 8; i++) await zoomOut.click();
  await expect(crew.getByText('50%', { exact: true })).toBeVisible();
  for (const label of ['Right', 'Back', 'Left', 'Front']) {
    await page.locator('#crew-view').selectOption(label.toLowerCase());
    await expect(crew.locator('canvas')).toHaveCount(1);
  }
  // El aviso sigue presente tras cambiar cámara y zoom: no se perdió el anclaje al marcador.
  await expect(crew.getByText(/Ringing|Timbrando|On call|En llamada/)).toBeVisible();
});

test('escena vacía: sin ningún agente real en PHONE_CALL, Crew no inventa ningún aviso de llamada (#145)', async ({ page }) => {
  await page.route('**/api/v1/snapshot', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ lastEventId: null, events: [], agents: [], totalTokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, totalCost: 0 }) }));
  await page.route('**/api/v1/events/stream*', route => route.abort());
  await page.goto('/?mode=live');
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  const crew = page.getByRole('region', { name: 'Crew mode: independent office' });
  await expect(crew.getByText('Empty office. Furniture remains visible.')).toBeVisible();
  await expect(crew.getByText(/Ringing|Timbrando|On call|En llamada/)).toHaveCount(0);
  await expect(crew.getByRole('button', { name: /Dismiss call notice|Descartar aviso de llamada/ })).toHaveCount(0);
});

test('si el icono real del banco no está disponible, el aviso sigue visible con su respaldo (#145)', async ({ page }) => {
  await page.route('**/*call.svg', route => route.abort());
  const consoleErrors: string[] = [];
  page.on('pageerror', error => consoleErrors.push(String(error)));
  const crew = await gotoLiveCrew(page);
  await expect(crew.getByText(/Ringing|Timbrando|On call|En llamada/)).toBeVisible();
  await expect(crew.locator('canvas')).toHaveCount(1);
  expect(consoleErrors).toHaveLength(0);
});

test('no hay regresión de Caricatura al alternar modos con una llamada real activa (#145)', async ({ page }) => {
  const crew = await gotoLiveCrew(page);
  await expect(crew.getByText(/Ringing|Timbrando|On call|En llamada/)).toBeVisible();
  await page.getByRole('button', { name: 'Cartoon', exact: true }).click();
  await expect(page.locator('canvas')).toHaveCount(1);
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await expect(crew.getByText('CEO Fixture:', { exact: false })).toBeVisible();
});

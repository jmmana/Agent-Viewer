import { expect, test } from '@playwright/test';

/**
 * #153: indicadores de alerta/severidad en Crew, cableados de verdad en `CrewStage.tsx`
 * (antes de esta entrega, un grep confirmaba cero referencias a `crewAlertBridge.ts` en
 * ese archivo). Aviso derivado solo del campo real `Agent.status`
 * (`crewAlertKindFromAgentStatus`, `crewAlertBridge.ts`), nunca de una simulación propia
 * de este test. Datos exclusivamente sintéticos; no se envían a un servidor real.
 *
 * Mismo molde que `crew-phone-call-145.spec.ts` (helper `gotoLiveCrew`, ruta de
 * `snapshot`/`stream` sintética): el acceptance test literal del issue es "varias
 * notificaciones simultáneas entre Development y QA; el usuario en Development ve solo
 * las de su oficina".
 */
const events = [
  { agentId: 'dev-fixture', type: 'agent.registered', payload: { name: 'Dev Fixture', workspace: 'development' } },
  { agentId: 'qa-fixture', type: 'agent.registered', payload: { name: 'QA Fixture', workspace: 'qa_lab' } },
  { agentId: 'dev-fixture', type: 'agent.status.changed', payload: { status: 'BLOCKED' } },
  { agentId: 'qa-fixture', type: 'agent.status.changed', payload: { status: 'WAITING_APPROVAL' } },
].map(({ agentId, type, payload }, index) => ({
  schemaVersion: '1.0', id: `crew-alert-${index}`, type, timestamp: Date.UTC(2026, 0, 1) + index,
  source: `agent:${agentId}`, agentId, severity: 'normal', summary: 'Synthetic alert fixture', payload,
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

test('dos oficinas con alertas simultáneas: Development solo ve la suya, QA solo la suya (#153)', async ({ page }) => {
  const crew = await gotoLiveCrew(page);
  await page.locator('#crew-room').selectOption('development');
  await expect(crew.getByText('Dev Fixture:', { exact: false })).toBeVisible();
  await expect(crew.getByText(/Blocked|Bloqueado/)).toBeVisible();
  // Aislamiento real: el agente en QA (con su propia alerta de aprobación) no está en
  // esta sala, así que su aviso nunca llega a este canvas/lista.
  await expect(crew.getByText(/Approval requested|Aprobación solicitada/)).toHaveCount(0);

  await page.locator('#crew-room').selectOption('qa');
  await expect(crew.getByText('QA Fixture:', { exact: false })).toBeVisible();
  await expect(crew.getByText(/Approval requested|Aprobación solicitada/)).toBeVisible();
  await expect(crew.getByText(/Blocked|Bloqueado/)).toHaveCount(0);

  // Volver a Development: la misma alerta real sigue ahí, cambiar de sala no la reinicia.
  await page.locator('#crew-room').selectOption('development');
  await expect(crew.getByText(/Blocked|Bloqueado/)).toBeVisible();
});

test('movimiento reducido conserva el estado de la alerta como texto (#153)', async ({ page }) => {
  const crew = await gotoLiveCrew(page);
  await page.locator('#crew-room').selectOption('development');
  const reducedMotion = page.locator('#crew-reduced-motion');
  await reducedMotion.check();
  await expect(reducedMotion).toBeChecked();
  await expect(crew.getByText(/Blocked|Bloqueado/)).toBeVisible();
});

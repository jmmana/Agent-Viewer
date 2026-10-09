import { expect, test } from '@playwright/test';

// Fixture sintético: un agente con consumo ya registrado por el servidor, como si una ejecución anterior ya
// hubiera corrido antes de abrir el portal (issue #72).
const registeredEvent = {
  schemaVersion: '1.0', id: 'evt-history-1', type: 'agent.registered', timestamp: Date.UTC(2026, 0, 1),
  source: 'agent:history-fixture', agentId: 'history-fixture', summary: 'Synthetic history fixture',
  payload: { name: 'History Fixture Dev', roleTitle: 'Developer', workspace: 'development' },
};

function snapshotBody() {
  return {
    lastEventId: 'evt-history-1',
    events: [registeredEvent],
    agents: [{ id: 'history-fixture', tokensInput: 1000, tokensOutput: 500, cachedTokens: 0, reasoningTokens: 0, cost: 0.25 }],
    totalTokens: { input: 1000, output: 500, cached: 0, reasoning: 0 },
    totalCost: 0.25,
  };
}

test('al abrir el portal LIVE se restaura el agente y las cifras del snapshot del servidor, sin recibir ningún evento nuevo', async ({ page }) => {
  await page.route('**/api/v1/snapshot', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshotBody()) }));
  // El stream nunca envía un evento: todo lo que aparece en pantalla viene del historial cargado antes de suscribirse.
  await page.route('**/api/v1/events/stream*', (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }));

  await page.goto('/?mode=live');

  // Las cifras y el agente vienen del snapshot, no de un evento en vivo.
  await expect(page.getByText('1.5K', { exact: true })).toBeVisible();
  await expect(page.getByText('$0.250', { exact: true })).toBeVisible();
  await expect(page.getByText('1 agents · 2.5D view', { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic history fixture', { exact: true })).toBeVisible();

  // El badge sale del estado de carga una vez el historial se aplicó; la fase final de conexión (live o
  // reconnecting, según el tiempo exacto de los reintentos nativos del EventSource mockeado) no es lo que esta
  // prueba audita.
  await expect(page.getByTestId('live-phase')).not.toHaveAttribute('data-phase', 'loading');
  await expect(page.getByTestId('live-phase')).not.toHaveAttribute('data-phase', 'error');
});

test('un historial más profundo que el snapshot se completa paginando con beforeId antes de suscribirse', async ({ page }) => {
  const deepEvent = {
    schemaVersion: '1.0', id: 'evt-history-0', type: 'agent.message.sent', timestamp: Date.UTC(2025, 11, 31),
    source: 'agent:history-fixture', agentId: 'history-fixture', summary: 'Older message',
    payload: { text: 'Older than the snapshot window' },
  };
  let pagedRequest: URL | null = null;

  await page.route('**/api/v1/snapshot', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshotBody()) }));
  // historyLoader siempre arma la query con `limit` primero; el patrón evita ambigüedad con la ruta del stream.
  await page.route('**/api/v1/events?limit=*', (route) => {
    pagedRequest = new URL(route.request().url());
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ schemaVersion: '1.0', count: 1, hasMore: false, nextBeforeId: null, events: [deepEvent] }),
    });
  });
  await page.route('**/api/v1/events/stream*', (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }));

  await page.goto('/?mode=live');

  await expect(page.getByText('1 agents · 2.5D view', { exact: true })).toBeVisible();
  await expect.poll(() => pagedRequest !== null).toBe(true);
  expect(pagedRequest!.searchParams.get('beforeId')).toBe('evt-history-1');
});

test('un snapshot que falla muestra el estado de error con reintento, y el reintento recupera el historial', async ({ page }) => {
  let snapshotCalls = 0;
  await page.route('**/api/v1/snapshot', (route) => {
    snapshotCalls++;
    if (snapshotCalls === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshotBody()) });
  });
  await page.route('**/api/v1/events/stream*', (route) => route.fulfill({ contentType: 'text/event-stream', body: '' }));

  await page.goto('/?mode=live');

  // Nunca se suscribe al stream sin un historial completo: el badge muestra el error, no CONNECTING.
  await expect(page.getByTestId('live-phase')).toHaveAttribute('data-phase', 'error');
  await expect(page.getByText('HISTORY UNAVAILABLE')).toBeVisible();

  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByText('1.5K', { exact: true })).toBeVisible();
  await expect(page.getByTestId('live-phase')).not.toHaveAttribute('data-phase', 'error');
  expect(snapshotCalls).toBe(2);
});

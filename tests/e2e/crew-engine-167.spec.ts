import { expect, test } from '@playwright/test';

// Evidencia reproducible del motor visual Crew independiente (issue #167): monta una sala
// realmente vacía (cero agentes en el store global) desde la app real, no un showroom ni un modo
// legado, y verifica que ningún elemento del renderer Caricatura (`av-canvas-root`, `av-toolbar`,
// `av-tool-btn`) exista en el DOM mientras Crew está activo, en escritorio y en móvil.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/snapshot', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ lastEventId: null, events: [], agents: [], totalTokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, totalCost: 0 }) }));
  await page.route('**/api/v1/events/stream*', route => route.abort());
});

for (const { label, width, height } of [
  { label: 'escritorio', width: 1440, height: 900 },
  { label: 'movil', width: 390, height: 844 },
]) {
  test(`motor Crew aislado monta una sala vacia sin elementos de Caricatura (${label})`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.goto('/?mode=live&visualMode=crew&crewRoom=finance');
    const region = page.getByRole('region', { name: 'Crew mode: independent office' });
    await expect(region).toBeVisible();
    await expect(region.getByText('Empty office. Furniture remains visible.', { exact: true })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(1);
    // Ningun elemento del renderer legado Caricatura debe existir mientras Crew esta activo,
    // no solo estar oculto: `av-canvas-root`/`av-toolbar`/`av-tool-btn` son clases exclusivas
    // de `OfficeCanvas.tsx` y nunca aparecen en el arbol de `CrewStage`.
    await expect(page.locator('.av-canvas-root')).toHaveCount(0);
    await expect(page.locator('.av-toolbar')).toHaveCount(0);
    await expect(page.locator('.av-tool-btn')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`crew-engine-empty-${label}.png`) });
    expect(errors).toEqual([]);
  });
}

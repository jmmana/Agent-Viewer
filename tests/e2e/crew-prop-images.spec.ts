import { expect, test } from '@playwright/test';

/**
 * Piloto acotado de #115: integra DOS muebles prototipo del banco Crew (escritorio
 * ejecutivo y planta de piso) como imagen real en la sala Dirección, en el Crew
 * independiente real (no el showroom, no Canvas de Caricatura). Sigue siendo
 * `status: prototype`, no arte aprobado; el resto de las once salas no cambia.
 *
 * Ambos SVG pesan menos del límite de inlining de Vite (4 KB): Vite los empaqueta
 * como `data:image/svg+xml` dentro de su propio módulo diferido, en dev y en build
 * (confirmado leyendo el módulo transformado y el bundle de producción), a
 * diferencia de los PNG del piloto CEO (#117/#118) que sí viajan como archivo con
 * hash. Por eso esta prueba identifica cada imagen por sus dimensiones naturales
 * reales (coinciden con `assets/crew/asset-manifest.json`) en vez de por URL de
 * red, y simula el fallo de carga interceptando el setter de `HTMLImageElement.src`
 * en vez de abortar una petición que nunca ocurre.
 */
const emptySnapshot = JSON.stringify({ lastEventId: null, events: [], agents: [],
  totalTokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, totalCost: 0 });

async function mockEmptyDomain(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/snapshot', route => route.fulfill({ contentType: 'application/json', body: emptySnapshot }));
  await page.route('**/api/v1/events/stream*', route => route.fulfill({ contentType: 'text/event-stream', body: '' }));
}

async function trackDrawnPropImages(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.drawImage;
    (window as any).__crewPropDrawn = [] as { width: number; height: number }[];
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      const source = args[0] as HTMLImageElement;
      if (source?.src?.startsWith('data:image/svg+xml')) {
        (window as any).__crewPropDrawn.push({ width: source.naturalWidth, height: source.naturalHeight });
      }
      return original.apply(this, args as any);
    };
  });
}

const DESK_SIZE = { width: 168, height: 100 };
const PLANT_SIZE = { width: 72, height: 102 };

test('escritorio y planta de Dirección se ven con la imagen real del banco en las cuatro cámaras', async ({ page }, info) => {
  await trackDrawnPropImages(page);
  await mockEmptyDomain(page);
  await page.goto('/?mode=live&visualMode=crew&crewRoom=ceo');
  await expect(page.getByTestId('crew-prop-art-status')).toHaveText('Furniture with real artwork: 2.');

  for (const view of ['front', 'right', 'back', 'left']) {
    await page.locator('#crew-view').selectOption(view);
    await expect(page.getByTestId('crew-prop-art-status')).toHaveText('Furniture with real artwork: 2.');
    await expect.poll(() => page.evaluate(size => (window as any).__crewPropDrawn
      .some((d: { width: number; height: number }) => d.width === size.width && d.height === size.height), DESK_SIZE)).toBe(true);
    await expect.poll(() => page.evaluate(size => (window as any).__crewPropDrawn
      .some((d: { width: number; height: number }) => d.width === size.width && d.height === size.height), PLANT_SIZE)).toBe(true);
    // La MISMA imagen se reutiliza como billboard en las cuatro cámaras: el banco no
    // tiene vistas verificadas por ángulo para estos dos muebles (ver manifiesto).
    await page.screenshot({ path: info.outputPath(`ceo-furniture-${view}.png`) });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('ceo-furniture-mobile.png') });

  // Fuera del alcance acotado: otra sala no pide ni dibuja estas imágenes.
  await page.locator('#crew-room').selectOption('development');
  await expect(page.getByTestId('crew-prop-art-status')).toHaveText('Furniture with real artwork: 0.');

  // Sin regresión: Caricatura sigue funcional y sin rastro del canvas/HUD de Crew.
  await page.getByRole('button', { name: 'Cartoon', exact: true }).click();
  await expect(page.getByTestId('crew-prop-art-status')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(1);
});

test('una imagen de mobiliario que falla al decodificar conserva el bloque 2.5D y lo informa en el estado', async ({ page }) => {
  // El SVG del escritorio se sirve inline (data URI), así que no hay petición de red
  // que abortar: se simula el fallo real de decodificación en el único punto donde
  // el navegador lo reportaría, el setter de `src`, dejando intacta la planta de piso.
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get() { return descriptor.get!.call(this); },
      set(value: string) {
        if (typeof value === 'string' && decodeURIComponent(value).includes('desk executive')) {
          descriptor.set!.call(this, '');
          queueMicrotask(() => this.dispatchEvent(new Event('error')));
          return;
        }
        descriptor.set!.call(this, value);
      },
    });
  });
  await mockEmptyDomain(page);
  await page.goto('/?mode=live&visualMode=crew&crewRoom=ceo');
  await expect(page.getByTestId('crew-prop-art-status')).toHaveText(
    'Furniture with real artwork: 1. Furniture image unavailable; the 2.5D block remains visible.');
  await expect(page.locator('canvas')).toBeVisible();
});

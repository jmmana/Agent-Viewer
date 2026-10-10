import { expect, test } from '@playwright/test';

/**
 * #157: controles de accesibilidad Crew operados solo con teclado, sin mouse.
 * No sustituye una prueba manual con VoiceOver/NVDA; documenta esa limitación
 * en el PR. Cubre mute/volumen (wiring, sin audio real todavía), alto
 * contraste, subtítulos y los presets de accesibilidad.
 */
test('controles de accesibilidad Crew operados por teclado #157', async ({ page }, testInfo) => {
  await page.goto('/?mode=live&visualMode=crew&crewRoom=development');
  await page.getByRole('button', { name: 'Reset Crew preferences', exact: true }).click();

  // Los controles nuevos viven colapsados en un <details>, para no empujar el
  // canvas fuera del viewport en móvil (ver crew-catalog.spec.ts). Se abre con
  // teclado: foco en el <summary> y Enter, sin usar el mouse.
  const summary = page.getByText('Crew accessibility and audio', { exact: true });
  await summary.focus();
  await page.keyboard.press('Enter');

  const highContrast = page.locator('#crew-high-contrast');
  const subtitles = page.locator('#crew-subtitles');
  const muted = page.locator('#crew-muted');
  const volume = page.locator('#crew-volume');
  const hudSize = page.locator('#crew-hud-size');
  const preset = page.locator('#crew-a11y-preset');

  // Estado inicial accesible: silenciado por defecto (sin audio real aún, #150),
  // subtítulos visibles, sin alto contraste.
  await expect(muted).toBeChecked();
  await expect(volume).toBeDisabled();
  await expect(subtitles).toBeChecked();
  await expect(highContrast).not.toBeChecked();

  // Mute/volumen por teclado: activar sonido habilita el control de volumen,
  // aunque todavía no haya ningún audio real que reproducir.
  await muted.focus();
  await page.keyboard.press('Space');
  await expect(muted).not.toBeChecked();
  await expect(volume).toBeEnabled();
  await volume.focus();
  const before = Number(await volume.inputValue());
  await page.keyboard.press('ArrowRight');
  const after = Number(await volume.inputValue());
  expect(after).toBeGreaterThan(before);

  // Alto contraste por teclado, sin clic de mouse.
  await highContrast.focus();
  await page.keyboard.press('Space');
  await expect(highContrast).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('crew-high-contrast.png') });

  // Subtítulos: al desactivarlos, el contenedor de anuncios de sala/cámara sigue
  // en el DOM (accesible a lectores de pantalla) pero deja de verse.
  const captions = page.locator('[data-crew-captions]');
  const captionsBefore = await captions.evaluate(el => getComputedStyle(el).position);
  expect(captionsBefore).not.toBe('absolute');
  await subtitles.focus();
  await page.keyboard.press('Space');
  await expect(subtitles).not.toBeChecked();
  const captionsAfter = await captions.evaluate(el => getComputedStyle(el).position);
  expect(captionsAfter).toBe('absolute');

  // Tamaño de HUD: mismo patrón que el resto de selects Crew (#171 ya usa
  // selectOption para '#crew-view'); el foco anterior demuestra que es
  // alcanzable con Tab, y la interacción nativa de un <select> abierto con
  // flechas de teclado no es fiable de automatizar en Chrome headless.
  await hudSize.focus();
  await hudSize.selectOption('large');
  await expect(hudSize).toHaveValue('large');

  // Presets de accesibilidad aplican varias preferencias de una vez.
  await page.getByRole('button', { name: 'Reset Crew preferences', exact: true }).click();
  await preset.selectOption('lowVision');
  await expect(highContrast).toBeChecked();
  await expect(hudSize).toHaveValue('large');
  await expect(subtitles).toBeChecked();

  await preset.selectOption('screenReader');
  await expect(page.locator('#crew-reduced-motion')).toBeChecked();
  await expect(subtitles).toBeChecked();
  await expect(hudSize).toHaveValue('large');

  // Reset deja las preferencias nuevas en sus valores por defecto, igual que #171.
  await page.getByRole('button', { name: 'Reset Crew preferences', exact: true }).click();
  await expect(muted).toBeChecked();
  await expect(highContrast).not.toBeChecked();
  await expect(hudSize).toHaveValue('standard');
  await expect(preset).toHaveValue('none');
});

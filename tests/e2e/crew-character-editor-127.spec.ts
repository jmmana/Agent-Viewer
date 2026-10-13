import { expect, test } from '@playwright/test';

/**
 * Reachability and persistence of the #127 character editor in the real
 * CrewStage tree (no mocks): the editor tool itself was already fully unit
 * tested (tests/lib/crewCharacterEditor127.test.tsx), but nothing rendered
 * it anywhere in the app, so it was never actually reachable. This spec
 * proves it now is, using the same `crew-walk` fixture tests/e2e/crew-walk.spec.ts
 * and tests/e2e/crew-agent-navigation-129.spec.ts already drive.
 */
test('the appearance panel is reachable, edits persist, and a reload keeps them', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/e2e/fixtures/crew-walk.html?walking=false');
  const panel = page.getByTestId('crew-character-panel-walk-fixture');
  await expect(panel).toBeVisible();

  // Collapsed by default: the selects inside are not yet interactable.
  const hairstyle = page.getByRole('combobox', { name: 'Hairstyle' });
  await expect(hairstyle).toBeHidden();
  await page.getByText('Customize appearance: Fixture CEO', { exact: true }).click();
  await expect(hairstyle).toBeVisible();

  const before = await hairstyle.inputValue();
  const options = await hairstyle.locator('option').allInnerTexts();
  expect(options.length).toBeGreaterThan(1);
  await hairstyle.selectOption({ index: 1 });
  const after = await hairstyle.inputValue();
  expect(after).not.toBe(before);
  await page.screenshot({ path: 'test-results/crew-character-editor-127/open-panel.png', fullPage: true });

  // Reload: the choice survives (localStorage, by agentId), the panel stays collapsed again.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Hairstyle' })).toBeHidden();
  await page.getByText('Customize appearance: Fixture CEO', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Hairstyle' })).toHaveValue(after);

  // Reset returns to the role's documented default.
  await page.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Hairstyle' })).toHaveValue(before);

  expect(errors).toEqual([]);
});

test('two agents keep fully independent appearances', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/crew-walk.html?walking=false');
  await page.getByText('Customize appearance: Fixture CEO', { exact: true }).click();
  const clothing = page.getByRole('combobox', { name: 'Clothing' });
  await clothing.selectOption({ index: 2 });
  const stored = await page.evaluate(() => localStorage.getItem('agent-viewer-crew-character-appearance-v1'));
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored!);
  expect(Object.keys(parsed.byAgentId)).toEqual(['walk-fixture']);
});

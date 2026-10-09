import { describe, expect, it } from 'vitest';
import {
  CREW_HIGH_CONTRAST_THEME,
  CREW_STANDARD_THEME,
  WCAG_AA_LARGE_TEXT_OR_UI,
  WCAG_AA_NORMAL_TEXT,
  WCAG_AAA_NORMAL_TEXT,
  crewContrastRatio,
  crewTheme,
} from '../../src/crew/crewContrast';

describe('Contraste WCAG de los temas Crew (#157)', () => {
  it('calcula relaciones de contraste conocidas de referencia', () => {
    expect(crewContrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(crewContrastRatio('#000000', '#000000')).toBeCloseTo(1, 5);
    expect(crewContrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Simétrico: el orden de los colores no cambia la relación.
    expect(crewContrastRatio('#101a2b', '#f1f5f9')).toBeCloseTo(crewContrastRatio('#f1f5f9', '#101a2b'), 10);
  });

  it('el tema estándar cumple AA para texto normal sobre su fondo', () => {
    const ratio = crewContrastRatio(CREW_STANDARD_THEME.text, CREW_STANDARD_THEME.background);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it('el tema de alto contraste cumple AAA y supera al estándar', () => {
    const highContrastRatio = crewContrastRatio(CREW_HIGH_CONTRAST_THEME.text, CREW_HIGH_CONTRAST_THEME.background);
    const standardRatio = crewContrastRatio(CREW_STANDARD_THEME.text, CREW_STANDARD_THEME.background);
    expect(highContrastRatio).toBeGreaterThanOrEqual(WCAG_AAA_NORMAL_TEXT);
    expect(highContrastRatio).toBeGreaterThan(standardRatio);
  });

  it('el color de acento de cada tema es distinguible de su fondo como componente de UI', () => {
    for (const theme of [CREW_STANDARD_THEME, CREW_HIGH_CONTRAST_THEME]) {
      expect(crewContrastRatio(theme.accent, theme.background)).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT_OR_UI);
      expect(crewContrastRatio(theme.focusRing, theme.background)).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT_OR_UI);
    }
  });

  it('crewTheme selecciona el tema correcto según la preferencia', () => {
    expect(crewTheme(false)).toBe(CREW_STANDARD_THEME);
    expect(crewTheme(true)).toBe(CREW_HIGH_CONTRAST_THEME);
  });
});

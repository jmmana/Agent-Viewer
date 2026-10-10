/**
 * Cálculo de contraste WCAG 2.1 (criterio 1.4.3/1.4.11) para la interfaz Crew,
 * y los dos temas de color que usa CrewStage: estándar y alto contraste (#157).
 * Sin dependencias externas; la fórmula sigue la relación de luminancia relativa
 * publicada por el W3C.
 */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean;
  const int = Number.parseInt(value, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function srgbToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** Relación de contraste WCAG entre dos colores hex, siempre >= 1. */
export function crewContrastRatio(hexA: string, hexB: string): number {
  const luminanceA = relativeLuminance(hexA);
  const luminanceB = relativeLuminance(hexB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Umbrales WCAG 2.1 usados por las pruebas de este módulo. */
export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT_OR_UI = 3;
export const WCAG_AAA_NORMAL_TEXT = 7;

export interface CrewTheme {
  background: string;
  surface: string;
  text: string;
  accent: string;
  focusRing: string;
}

export const CREW_STANDARD_THEME: CrewTheme = {
  background: '#101a2b',
  surface: '#142339',
  text: '#f1f5f9',
  // #3b82f6 en vez del azul original #1d4ed8: el original daba 2.6:1 sobre el
  // fondo, por debajo del mínimo WCAG de componentes de UI (3:1).
  accent: '#3b82f6',
  focusRing: '#60a5fa',
};

export const CREW_HIGH_CONTRAST_THEME: CrewTheme = {
  background: '#000000',
  surface: '#000000',
  text: '#ffffff',
  accent: '#ffd400',
  focusRing: '#00e5ff',
};

export function crewTheme(highContrast: boolean): CrewTheme {
  return highContrast ? CREW_HIGH_CONTRAST_THEME : CREW_STANDARD_THEME;
}

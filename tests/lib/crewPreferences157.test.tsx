import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentOffice } from '../../src/lib/AgentOffice';
import {
  applyCrewAccessibilityPreset,
  defaultCrewPreferences,
  validateCrewPreferences,
  CREW_HUD_SCALE,
} from '../../src/crew/crewPreferences';

vi.mock('../../src/crew/crewSprites', async importOriginal => ({
  ...await importOriginal<object>(),
  loadCrewImage: vi.fn((_url, _size, ready) => { ready({} as HTMLImageElement); return vi.fn(); }),
}));
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('Preferencias de accesibilidad Crew #157', () => {
  it('agrega mute/volumen/alto contraste/subtítulos/HUD/preset con valores por defecto accesibles', () => {
    const defaults = defaultCrewPreferences();
    expect(defaults).toEqual({
      version: 1,
      reducedMotion: false,
      muted: true,
      volume: 0.6,
      highContrast: false,
      subtitles: true,
      hudSize: 'standard',
      accessibilityPreset: 'none',
    });
  });

  it('valida campo a campo y recupera datos previos a #157 que no tenían los campos nuevos', () => {
    // Formato guardado por una versión anterior, solo con reducedMotion.
    expect(validateCrewPreferences({ version: 1, reducedMotion: true })).toEqual({
      ...defaultCrewPreferences(),
      reducedMotion: true,
    });
    expect(validateCrewPreferences({ version: 1, hudSize: 'huge', accessibilityPreset: 'xyz' })).toEqual(
      defaultCrewPreferences(),
    );
    // El volumen fuera de rango se recorta a [0,1] en vez de descartarse por completo.
    expect(validateCrewPreferences({ version: 1, volume: 5 }).volume).toBe(1);
    expect(validateCrewPreferences({ version: 1, volume: -2 }).volume).toBe(0);
    expect(validateCrewPreferences({ version: 1, volume: 'loud' }).volume).toBe(defaultCrewPreferences().volume);
    expect(validateCrewPreferences({ version: 1, hudSize: 'large' }).hudSize).toBe('large');
    expect(validateCrewPreferences({ version: 1, accessibilityPreset: 'lowVision' }).accessibilityPreset).toBe('lowVision');
  });

  it('aplica presets de accesibilidad de forma atómica', () => {
    const base = defaultCrewPreferences();
    const screenReader = applyCrewAccessibilityPreset(base, 'screenReader');
    expect(screenReader).toMatchObject({ accessibilityPreset: 'screenReader', subtitles: true, reducedMotion: true, hudSize: 'large' });
    const lowVision = applyCrewAccessibilityPreset(base, 'lowVision');
    expect(lowVision).toMatchObject({ accessibilityPreset: 'lowVision', highContrast: true, hudSize: 'large', subtitles: true });
    expect(applyCrewAccessibilityPreset(screenReader, 'none')).toMatchObject({ accessibilityPreset: 'none' });
  });

  it('la escala de HUD crece de compacto a grande', () => {
    expect(CREW_HUD_SCALE.compact).toBeLessThan(CREW_HUD_SCALE.standard);
    expect(CREW_HUD_SCALE.standard).toBeLessThan(CREW_HUD_SCALE.large);
  });

  it('expone los controles nuevos con nombre accesible y los conecta a las preferencias', () => {
    render(<AgentOffice visualMode="crew" />);
    // Los controles nuevos viven en un <details> colapsado por defecto (para
    // no empujar el canvas fuera del viewport en móvil); se abre con teclado
    // igual que cualquier otro <summary>.
    fireEvent.click(screen.getByText('Crew accessibility and audio'));
    const highContrast = screen.getByRole('checkbox', { name: 'High contrast' }) as HTMLInputElement;
    const subtitles = screen.getByRole('checkbox', { name: 'Room and camera change captions' }) as HTMLInputElement;
    const muted = screen.getByRole('checkbox', { name: 'Mute Crew audio' }) as HTMLInputElement;
    const volume = screen.getByRole('slider', { name: 'Crew volume' }) as HTMLInputElement;
    const hudSize = screen.getByRole('combobox', { name: 'Controls size' }) as HTMLSelectElement;
    const preset = screen.getByRole('combobox', { name: 'Accessibility preset' }) as HTMLSelectElement;

    expect(highContrast.checked).toBe(false);
    expect(subtitles.checked).toBe(true);
    expect(muted.checked).toBe(true);
    expect(volume.disabled).toBe(true);
    expect(hudSize.value).toBe('standard');

    fireEvent.click(muted);
    expect(volume.disabled).toBe(false);

    fireEvent.click(highContrast);
    expect(highContrast.checked).toBe(true);

    fireEvent.change(preset, { target: { value: 'lowVision' } });
    expect((screen.getByRole('checkbox', { name: 'High contrast' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Controls size' }) as HTMLSelectElement).value).toBe('large');
  });

  it('las subtítulos aparecen visibles al activarlos y se mantienen accesibles pero ocultos al desactivarlos', () => {
    render(<AgentOffice visualMode="crew" ariaLabel="Stage" />);
    fireEvent.click(screen.getByRole('button', { name: 'Next office' }));
    const captions = document.querySelector('[data-crew-captions]') as HTMLElement;
    fireEvent.click(screen.getByText('Crew accessibility and audio'));
    expect(captions.style.position).not.toBe('absolute');
    expect(captions.textContent).not.toBe('');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Room and camera change captions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous office' }));
    // El contenedor sigue en el DOM para lectores de pantalla, pero visualmente oculto.
    expect(captions.style.position).toBe('absolute');
    expect(captions.style.width).toBe('1px');
  });
});

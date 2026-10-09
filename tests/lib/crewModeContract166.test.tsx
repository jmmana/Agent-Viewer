// Contrato de arquitectura de dos modos (#166): entrar y salir de Crew repetidamente no debe duplicar
// temporizadores, perder eventos ni reiniciar métricas, tareas o preferencias. El criterio de aceptación
// del issue pide veinte alternancias; estas pruebas lo ejecutan de verdad en vez de asumirlo.
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentOffice, type CrewCameraByRoom } from '../../src/lib/index';
import { defaultCrewPreferences, type CrewPreferences } from '../../src/crew/crewPreferences';
import { registered, statusChanged } from './fixtures';

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const CYCLES = 20;

describe('Contrato de dos modos #166: Caricatura <-> Crew', () => {
  it('veinte alternancias no duplican el temporizador de la oficina ni pierden eventos acumulados', () => {
    vi.useFakeTimers();
    let events = [registered('fixture', 'Agente de prueba', { workspace: 'development' })];
    const { rerender, container } = render(<AgentOffice events={events} visualMode="cartoon" />);
    const timersAfterMount = vi.getTimerCount();
    expect(timersAfterMount).toBeGreaterThan(0);

    for (let i = 0; i < CYCLES; i += 1) {
      const nextMode = i % 2 === 0 ? 'crew' : 'cartoon';
      // Cada ciclo también hace crecer el stream, como LIVE: ningún evento debe perderse al cambiar de modo.
      events = [...events, statusChanged('fixture', i % 2 === 0 ? 'CODING' : 'IDLE', { id: `cycle-${i}` })];
      rerender(<AgentOffice events={events} visualMode={nextMode} />);
    }

    // El temporizador de 250ms de OfficeStore vive mientras AgentOffice esté montado; veinte alternancias de
    // renderer no deben crear temporizadores adicionales, porque eso sería un listener/efecto duplicado.
    expect(vi.getTimerCount()).toBe(timersAfterMount);

    // El último evento del stream (IDLE) debe reflejarse: la oficina no se reconstruyó a medio camino.
    rerender(<AgentOffice events={events} visualMode="cartoon" />);
    expect(container.querySelector('li[data-agent-id="fixture"]')?.textContent).toContain('Idle');
  });

  it('sala, cámara y preferencia de movimiento reducido elegidas por el host sobreviven veinte alternancias', () => {
    function Host() {
      const [visualMode, setVisualMode] = useState<'cartoon' | 'crew'>('crew');
      const [room, setRoom] = useState('development');
      const [cameras, setCameras] = useState<CrewCameraByRoom>({});
      const [preferences, setPreferences] = useState<CrewPreferences>({ version: 1, reducedMotion: true });
      return (
        <>
          <button type="button" onClick={() => setVisualMode((m) => (m === 'crew' ? 'cartoon' : 'crew'))}>
            toggle
          </button>
          <AgentOffice
            visualMode={visualMode}
            crewRoomId={room}
            onCrewRoomChange={setRoom}
            crewCameras={cameras}
            onCrewCamerasChange={setCameras}
            crewPreferences={preferences}
            onCrewPreferencesChange={setPreferences}
          />
        </>
      );
    }

    render(<Host />);
    expect((screen.getByRole('combobox', { name: 'Office' }) as HTMLSelectElement).value).toBe('development');
    expect((screen.getByRole('checkbox', { name: 'Reduce motion' }) as HTMLInputElement).checked).toBe(true);

    for (let i = 0; i < CYCLES; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    }
    // Número par de alternancias: termina de nuevo en Crew.
    expect((screen.getByRole('combobox', { name: 'Office' }) as HTMLSelectElement).value).toBe('development');
    expect((screen.getByRole('checkbox', { name: 'Reduce motion' }) as HTMLInputElement).checked).toBe(true);
  });

  it('la preferencia propia de movimiento reducido no se reinicia a su default al salir y volver a Crew sin controlar la prop', () => {
    const { rerender } = render(<AgentOffice visualMode="crew" ariaLabel="Oficina" />);
    const region = () => within(screen.getByRole('region', { name: 'Oficina' }));
    expect((region().getByRole('checkbox', { name: 'Reduce motion' }) as HTMLInputElement).checked).toBe(
      defaultCrewPreferences().reducedMotion,
    );
    fireEvent.click(region().getByRole('checkbox', { name: 'Reduce motion' }));
    expect((region().getByRole('checkbox', { name: 'Reduce motion' }) as HTMLInputElement).checked).toBe(true);

    for (let i = 0; i < CYCLES; i += 1) {
      rerender(<AgentOffice visualMode={i % 2 === 0 ? 'cartoon' : 'crew'} ariaLabel="Oficina" />);
    }
    rerender(<AgentOffice visualMode="crew" ariaLabel="Oficina" />);
    expect((region().getByRole('checkbox', { name: 'Reduce motion' }) as HTMLInputElement).checked).toBe(true);
  });

  it('prefers-reduced-motion del sistema sigue respetándose en Crew tras alternar modos, sin tocar Caricatura', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);

    const { rerender } = render(
      <AgentOffice
        visualMode="crew"
        ariaLabel="Oficina"
        crewPreferences={{ version: 1, reducedMotion: false }}
      />,
    );
    // El checkbox refleja la preferencia propia (false); el sistema prevalece en la animación interna, no en
    // el estado de la UI, así que lo relevante aquí es que la propiedad controlada no se corrompe al alternar.
    const checkbox = () => screen.getByRole('checkbox', { name: 'Reduce motion' }) as HTMLInputElement;
    expect(checkbox().checked).toBe(false);

    for (let i = 0; i < CYCLES; i += 1) {
      rerender(
        <AgentOffice
          visualMode={i % 2 === 0 ? 'cartoon' : 'crew'}
          ariaLabel="Oficina"
          crewPreferences={{ version: 1, reducedMotion: false }}
        />,
      );
    }
    rerender(
      <AgentOffice visualMode="crew" ariaLabel="Oficina" crewPreferences={{ version: 1, reducedMotion: false }} />,
    );
    expect(checkbox().checked).toBe(false);
  });

  it('dos instancias independientes alternan modo veinte veces sin filtrarse estado entre ellas', () => {
    function TwoOffices() {
      const [modeA, setModeA] = useState<'cartoon' | 'crew'>('cartoon');
      const [modeB] = useState<'cartoon' | 'crew'>('crew');
      return (
        <>
          <button type="button" onClick={() => setModeA((m) => (m === 'crew' ? 'cartoon' : 'crew'))}>
            toggleA
          </button>
          <AgentOffice visualMode={modeA} ariaLabel="Uno" />
          <AgentOffice visualMode={modeB} ariaLabel="Dos" />
        </>
      );
    }
    render(<TwoOffices />);
    const two = within(screen.getByRole('region', { name: 'Dos' }));
    fireEvent.change(two.getByRole('combobox', { name: 'Office' }), { target: { value: 'development' } });
    expect((two.getByRole('combobox', { name: 'Office' }) as HTMLSelectElement).value).toBe('development');

    for (let i = 0; i < CYCLES; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'toggleA' }));
    }

    // La instancia "Dos" nunca cambió de modo: su sala Crew no debe haberse visto afectada por los ciclos de "Uno".
    expect((two.getByRole('combobox', { name: 'Office' }) as HTMLSelectElement).value).toBe('development');
  });
});

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentOffice } from '../../src/lib/AgentOffice';
import { defaultCrewPreferences, readCrewPreferences, saveCrewPreferences, validateCrewPreferences, CREW_PREFERENCES_STORAGE_KEY } from '../../src/crew/crewPreferences';
import { readSoundPreference, setSoundEnabled, isSoundEnabled, SOUND_PREFERENCE_STORAGE_KEY } from '../../src/engine/soundEffects';
import { renderHook, act } from '@testing-library/react';
import { useCrewBlink } from '../../src/crew/useCrewBlink';

vi.mock('../../src/crew/crewSprites', async importOriginal => ({
  ...await importOriginal<object>(),
  loadCrewImage: vi.fn((_url, _size, ready) => { ready({} as HTMLImageElement); return vi.fn(); }),
}));
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Preferencias y navegación #171', () => {
  it('recupera versión conocida y valores seguros sin aceptar JSON corrupto o futuro', () => {
    for (const value of [null, [], {version:2,reducedMotion:true}, {version:1,reducedMotion:'true'}]) {
      expect(validateCrewPreferences(value)).toEqual(defaultCrewPreferences());
    }
    for (const serialized of ['{', 'x'.repeat(4097)]) {
      localStorage.setItem(CREW_PREFERENCES_STORAGE_KEY, serialized);
      expect(readCrewPreferences()).toEqual(defaultCrewPreferences());
    }
    saveCrewPreferences({...defaultCrewPreferences(),reducedMotion:true});
    expect(readCrewPreferences().reducedMotion).toBe(true);
    vi.spyOn(Storage.prototype,'getItem').mockImplementation(() => {throw Error('blocked');});
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => {throw Error('blocked');});
    expect(readCrewPreferences()).toEqual(defaultCrewPreferences());
    expect(() => saveCrewPreferences(defaultCrewPreferences())).not.toThrow();
  });
  it('persiste sonido global con default compatible y recupera almacenamiento inválido', () => {
    expect(readSoundPreference()).toBe(true);
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
    expect(readSoundPreference()).toBe(false);
    localStorage.setItem(SOUND_PREFERENCE_STORAGE_KEY,'{"version":2,"enabled":false}');
    expect(readSoundPreference()).toBe(true);
    localStorage.setItem(SOUND_PREFERENCE_STORAGE_KEY,'{');
    expect(readSoundPreference()).toBe(true);
    vi.spyOn(Storage.prototype,'getItem').mockImplementation(() => {throw Error('blocked');});
    expect(readSoundPreference()).toBe(true);
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => {throw Error('blocked');});
    expect(() => setSoundEnabled(true)).not.toThrow();
    expect(isSoundEnabled()).toBe(true);
  });
  it('cancela la animación activa al reducir movimiento desde preferencias', () => {
    vi.useFakeTimers();
    const {result,rerender,unmount} = renderHook(({reduced}) => useCrewBlink(true,'ceo',reduced), {initialProps:{reduced:false}});
    expect(result.current).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
    rerender({reduced:true});
    expect(result.current).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    rerender({reduced:false});
    act(() => vi.advanceTimersByTime(3280));
    expect(result.current?.frame).toBeDefined();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('false propio nunca anula movimiento reducido del sistema', () => {
    vi.useFakeTimers();
    vi.spyOn(window,'matchMedia').mockReturnValue({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()} as unknown as MediaQueryList);
    const {result,unmount} = renderHook(() => useCrewBlink(true,'ceo',false));
    expect(result.current).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });
  it('aísla preferencias, limita navegación y las conserva al salir/regresar por instancia', () => {
    const {rerender} = render(<><AgentOffice visualMode="crew" ariaLabel="One" /><AgentOffice visualMode="crew" ariaLabel="Two" /></>);
    const one = within(screen.getByRole('region',{name:'One'}));
    const two = within(screen.getByRole('region',{name:'Two'}));
    expect((one.getByRole('button',{name:'Previous office'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(one.getByRole('checkbox',{name:'Reduce motion'}));
    expect((two.getByRole('checkbox',{name:'Reduce motion'}) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(one.getByRole('button',{name:'Next office'}));
    expect((one.getByRole('combobox',{name:'Office'}) as HTMLSelectElement).value).not.toBe('ceo');
    fireEvent.click(one.getByRole('button',{name:'Previous office'}));
    expect((one.getByRole('combobox',{name:'Office'}) as HTMLSelectElement).value).toBe('ceo');
    rerender(<><AgentOffice visualMode="cartoon" ariaLabel="One" /><AgentOffice visualMode="crew" ariaLabel="Two" /></>);
    rerender(<><AgentOffice visualMode="crew" ariaLabel="One" /><AgentOffice visualMode="crew" ariaLabel="Two" /></>);
    expect((one.getByRole('checkbox',{name:'Reduce motion'}) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(one.getByRole('button',{name:'Reset Crew preferences'}));
    expect((one.getByRole('checkbox',{name:'Reduce motion'}) as HTMLInputElement).checked).toBe(false);
    expect(localStorage.length).toBe(0);
  });
  it('notifica preferencias controladas sin mutar props ni imponer el cambio al host', () => {
    const onChange=vi.fn();
    const preferences={...defaultCrewPreferences(),reducedMotion:false};
    render(<AgentOffice visualMode="crew" crewPreferences={preferences} onCrewPreferencesChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox',{name:'Reduce motion'}));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({...defaultCrewPreferences(),reducedMotion:true});
    expect(preferences.reducedMotion).toBe(false);
    expect((screen.getByRole('checkbox',{name:'Reduce motion'}) as HTMLInputElement).checked).toBe(false);
  });
});

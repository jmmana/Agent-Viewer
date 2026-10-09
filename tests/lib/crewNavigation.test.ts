import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREW_NAVIGATION_STORAGE_KEY, defaultCrewNavigation, parseCrewNavigation, readCrewNavigation, saveCrewNavigation } from '../../src/crew/crewNavigation';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('Preferencias de navegación Crew', () => {
  it('mantiene Caricatura como opción inicial y restaura una sala registrada', () => {
    expect(readCrewNavigation()).toEqual(defaultCrewNavigation());
    const value = { version: 1 as const, selectedMode: 'crew' as const, selectedRoomId: 'development' };
    saveCrewNavigation(value);
    expect(readCrewNavigation()).toEqual(value);
  });
  it('descarta versiones desconocidas, JSON corrupto y entradas excesivas', () => {
    for (const value of ['{', 'null', '[]', 'x'.repeat(4097), '{"version":2,"selectedMode":"crew"}']) {
      expect(parseCrewNavigation(value)).toEqual(defaultCrewNavigation());
    }
  });
  it('sustituye una sala eliminada y descarta campos de dominio', () => {
    expect(parseCrewNavigation(JSON.stringify({ version:1, selectedMode:'crew', selectedRoomId:'removed', agents:['fake'] })))
      .toEqual({version:1,selectedMode:'crew',selectedRoomId:'ceo'});
  });
  it('no modifica la sesión ni las cámaras existentes', () => {
    localStorage.setItem('agent-viewer-crew-camera-v1', 'camera');
    localStorage.setItem('session', 'events');
    saveCrewNavigation(defaultCrewNavigation());
    expect(localStorage.getItem('agent-viewer-crew-camera-v1')).toBe('camera');
    expect(localStorage.getItem('session')).toBe('events');
    expect(localStorage.getItem(CREW_NAVIGATION_STORAGE_KEY)).not.toBeNull();
  });
  it('permite navegar cuando el almacenamiento rechaza lectura o escritura', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(readCrewNavigation()).toEqual(defaultCrewNavigation());
    expect(() => saveCrewNavigation(defaultCrewNavigation())).not.toThrow();
  });
});

describe('Enlaces de oficinas Crew', () => {
  it('da prioridad al enlace sin interpretar mode=live como modo visual', async () => {
    const { resolveCrewEntry } = await import('../../src/crew/crewNavigation');
    const saved = {version:1 as const,selectedMode:'cartoon' as const,selectedRoomId:'ceo'};
    expect(resolveCrewEntry(saved,'?mode=live&crewRoom=development')).toEqual({
      navigation:{version:1,selectedMode:'crew',selectedRoomId:'development'},missingRoom:false,
    });
    expect(resolveCrewEntry(saved,'?mode=live').navigation).toEqual(saved);
  });
  it('avisa de salas desconocidas sin almacenar el texto arbitrario de la URL', async () => {
    const { resolveCrewEntry } = await import('../../src/crew/crewNavigation');
    const entry = resolveCrewEntry(defaultCrewNavigation(), '?crewRoom=missing');
    expect(entry.missingRoom).toBe(true);
    expect(entry.navigation.selectedRoomId).toBe('ceo');
  });
  it('el enlace compartible conserva LIVE y subruta pero omite credenciales y datos ajenos', async () => {
    const { crewRoomLink } = await import('../../src/crew/crewNavigation');
    expect(crewRoomLink('https://example.test/Agent-Viewer/?mode=live&token=private#secret','development'))
      .toBe('/Agent-Viewer/?mode=live&visualMode=crew&crewRoom=development');
  });
});

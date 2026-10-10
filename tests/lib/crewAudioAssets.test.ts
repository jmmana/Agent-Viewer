import { describe, expect, it } from 'vitest';
import { CREW_AUDIO_MANIFEST, CREW_ROOM_MUSIC, crewAudioAssetInfo } from '../../src/crew/crewAudioAssets';
import { CREW_ROOMS } from '../../src/crew/crewModel';

describe('Manifiesto de audio de Crew (#150): origen y licencia verificables', () => {
  it('cada sonido documenta origen, licencia y etiqueta bilingüe no vacíos', () => {
    expect(CREW_AUDIO_MANIFEST.length).toBeGreaterThan(0);
    for (const asset of CREW_AUDIO_MANIFEST) {
      expect(asset.label.en.trim()).not.toHaveLength(0);
      expect(asset.label.es.trim()).not.toHaveLength(0);
      expect(asset.origin.trim()).not.toHaveLength(0);
      expect(asset.license.trim()).not.toHaveLength(0);
      expect(asset.notes.en.trim()).not.toHaveLength(0);
      expect(asset.notes.es.trim()).not.toHaveLength(0);
      // Ningún sonido es una muestra grabada: la licencia debe dejarlo explícito.
      expect(asset.license.toLowerCase()).toMatch(/cc0|dominio p[uú]blico|public domain/);
    }
  });

  it('crewAudioAssetInfo() resuelve cada id del mapa de salas y lanza para uno inexistente', () => {
    for (const trackId of Object.values(CREW_ROOM_MUSIC)) {
      if (trackId) expect(() => crewAudioAssetInfo(trackId)).not.toThrow();
    }
    // @ts-expect-error: id deliberadamente inválido para probar el camino de error.
    expect(() => crewAudioAssetInfo('no-existe')).toThrow();
  });

  it('solo la sala de descanso tiene música de fondo: ninguna otra sala reproduce la pista de Lounge por accidente', () => {
    const roomIds = CREW_ROOMS.map(room => room.id);
    for (const roomId of roomIds) {
      expect(Object.prototype.hasOwnProperty.call(CREW_ROOM_MUSIC, roomId)).toBe(true);
      if (roomId === 'lounge') expect(CREW_ROOM_MUSIC[roomId]).toBe('lounge-ambient');
      else expect(CREW_ROOM_MUSIC[roomId]).toBeNull();
    }
  });
});

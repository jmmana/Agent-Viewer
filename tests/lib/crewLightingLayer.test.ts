import { describe, expect, it } from 'vitest';
import { CREW_PROP_SHADES, crewFloorColor, crewPresenceBadgeColor } from '../../src/crew/crewLightingLayer';

describe('Crew lighting layer (paleta de sombreado)', () => {
  it('da a Dirección un tono de piso distinto del resto de salas', () => {
    expect(crewFloorColor({ id: 'ceo' })).toBe('#d9c6a9');
    expect(crewFloorColor({ id: 'development' })).toBe('#b3bdc7');
    expect(crewFloorColor({ id: 'coffee' })).toBe(crewFloorColor({ id: 'development' }));
  });

  it('da a cada tipo de mueble tres tonos distintos (superior, lateral, frontal)', () => {
    for (const type of ['desk', 'chair', 'plant', 'screen'] as const) {
      const shade = CREW_PROP_SHADES[type];
      expect(new Set([shade.top, shade.side, shade.front]).size).toBe(3);
    }
  });

  it('los cuatro tipos de mueble tienen tonos distintos entre sí', () => {
    const tops = (['desk', 'chair', 'plant', 'screen'] as const).map(type => CREW_PROP_SHADES[type].top);
    expect(new Set(tops).size).toBe(4);
  });

  it('colorea la insignia de presencia en rojo solo para ERROR y BLOCKED', () => {
    expect(crewPresenceBadgeColor('ERROR')).toBe('#b91c1c');
    expect(crewPresenceBadgeColor('BLOCKED')).toBe('#b91c1c');
    for (const status of ['IDLE', 'CODING', 'THINKING', 'REVIEWING']) {
      expect(crewPresenceBadgeColor(status)).toBe('#1d4ed8');
    }
  });
});

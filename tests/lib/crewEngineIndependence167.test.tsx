import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CrewStage } from '../../src/crew/CrewStage';
import { CREW_ROOMS } from '../../src/crew/crewModel';

/**
 * Motor visual Crew independiente (issue #167): montar una sala vacia (cero agentes, el valor
 * por defecto de `CrewStage`) no debe producir en el DOM ningun elemento del renderer legado
 * Caricatura (`src/components/OfficeCanvas.tsx`). `tests/crew-mode-boundary-166.test.mjs` ya
 * prueba esto por analisis estatico de imports; esta prueba lo confirma a nivel de arbol DOM
 * real, montando y desmontando con React Testing Library, sin pasar `agents` (sala
 * genuinamente vacia) para cada una de las once salas del catalogo.
 */
describe('Independencia de DOM del motor Crew frente a Caricatura (#167)', () => {
  it.each(CREW_ROOMS.map(room => room.id))('sala %s: monta vacia, sin marcadores de Caricatura, y desmonta limpia', (roomId) => {
    const { container, unmount } = render(
      <CrewStage locale="es" selectedRoomId={roomId} persistCamera={false} showRoomLink={false} />,
    );
    // Exactamente un canvas (el de Crew) y ningun marcador exclusivo de OfficeCanvas.tsx.
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    expect(container.querySelectorAll('.av-canvas-root')).toHaveLength(0);
    expect(container.querySelectorAll('.av-toolbar')).toHaveLength(0);
    expect(container.querySelectorAll('.av-tool-btn')).toHaveLength(0);
    expect(container.querySelector('[aria-label*="Crew mode"], [aria-label*="Modo Crew"]')).not.toBeNull();
    unmount();
    expect(container.querySelectorAll('canvas')).toHaveLength(0);
  });
});

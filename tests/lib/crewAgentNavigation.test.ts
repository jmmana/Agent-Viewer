import { describe, expect, it } from 'vitest';
import { CREW_ROOMS, crewRoom } from '../../src/crew/crewModel';
import { buildCrewWalkGraph, defaultCrewDoorStates, setCrewDoorState } from '../../src/crew/crewRoutes';
import {
  canCrewReachRoom,
  crewPathAvoidsFurniture,
  crewWorkstationHolder,
  planCrewRoomTransfer,
  planCrewWalkWithinRoom,
  releaseCrewWorkstation,
  reserveCrewWorkstation,
  type CrewWorkstationReservations,
} from '../../src/crew/crewAgentNavigation';

/** Busca, entre los nodos del grafo caminable, un par conectado que avance exactamente en una dirección cardinal. */
function findCardinalStep(nodes: readonly { x: number; y: number }[], neighbors: ReadonlyArray<readonly number[]>, dx: number, dy: number) {
  for (let i = 0; i < nodes.length; i++) {
    for (const j of neighbors[i]) {
      if (Math.abs(nodes[j].x - nodes[i].x - dx) < 1e-6 && Math.abs(nodes[j].y - nodes[i].y - dy) < 1e-6) {
        return { from: nodes[i], to: nodes[j] };
      }
    }
  }
  return null;
}

describe('navegación dentro de una sala (#129)', () => {
  it.each(['ceo', 'development'])('camina en los 4 sentidos cardinales dentro de %s evitando el mobiliario real', (roomId) => {
    const room = crewRoom(roomId)!;
    const walk = buildCrewWalkGraph(room);
    const directions: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let exercised = 0;
    for (const [dx, dy] of directions) {
      const step = findCardinalStep(walk.nodes, walk.neighbors, dx, dy);
      if (!step) continue;
      exercised += 1;
      const path = planCrewWalkWithinRoom(room, step.from, step.to);
      expect(path).toEqual([step.from, step.to]);
      expect(crewPathAvoidsFurniture(room, path!)).toBe(true);
    }
    // Una sala real con mobiliario distinto en cada esquina expone al menos 3 de los 4 sentidos.
    expect(exercised).toBeGreaterThanOrEqual(3);
  });

  it('encuentra una ruta entre dos esquinas lejanas de Development sin atravesar sus 6 muebles', () => {
    const room = crewRoom('development')!;
    const walk = buildCrewWalkGraph(room);
    const from = walk.nodes[0];
    const to = walk.nodes[walk.nodes.length - 1];
    const path = planCrewWalkWithinRoom(room, from, to);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual(from);
    expect(path![path!.length - 1]).toEqual(to);
    expect(crewPathAvoidsFurniture(room, path!)).toBe(true);
  });

  it('nunca atraviesa un escritorio real: reutiliza crewCollision.ts, no reinventa la colisión', () => {
    const room = crewRoom('development')!;
    // dev-desk-1 está anclado en (3,4) con huella 1.5x.9: su caja cubre x en [2.25,3.75], y en [3.55,4.45].
    const throughTheDesk = [{ x: 2, y: 4 }, { x: 3, y: 4 }, { x: 4, y: 4 }];
    expect(crewPathAvoidsFurniture(room, throughTheDesk)).toBe(false);
  });

  it('un tramo que sortea el escritorio por fuera de su huella sí queda libre', () => {
    const room = crewRoom('development')!;
    const clear = [{ x: 2, y: 1 }, { x: 4, y: 1 }];
    expect(crewPathAvoidsFurniture(room, clear)).toBe(true);
  });

  it('una sala sin ningún nodo caminable (huella inválida) devuelve null en vez de lanzar', () => {
    const emptyRoom = { ...crewRoom('ceo')!, width: 0, depth: 0, furniture: [] };
    const path = planCrewWalkWithinRoom(emptyRoom, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(path).toBeNull();
  });

  it('un punto que no pertenece al grafo caminable de la sala no inventa una ruta', () => {
    const room = crewRoom('qa')!;
    const walk = buildCrewWalkGraph(room);
    const path = planCrewWalkWithinRoom(room, { x: -5, y: -5 }, walk.nodes[0]);
    expect(path).toBeNull();
  });
});

describe('navegación entre salas respetando puertas (#129)', () => {
  it('confirma primero con reachableCrewRooms que el destino es alcanzable', () => {
    expect(canCrewReachRoom('ceo', 'infrastructure')).toBe(true);
  });

  it('planea una ruta real multi-sala, entrando y saliendo por cada puerta, sin teletransportes', () => {
    const route = planCrewRoomTransfer('ceo', 'infrastructure');
    expect(route).not.toBeNull();
    expect(route!.rooms[0]).toBe('ceo');
    expect(route!.rooms[route!.rooms.length - 1]).toBe('infrastructure');
    expect(route!.segments).toHaveLength(route!.rooms.length);
    for (const segment of route!.segments) {
      const room = crewRoom(segment.roomId)!;
      expect(segment.path.length).toBeGreaterThan(0);
      expect(crewPathAvoidsFurniture(room, segment.path)).toBe(true);
    }
  });

  it('una puerta cerrada que separa dos salas deja la ruta inexistente, nunca un atajo inventado', () => {
    const locked = setCrewDoorState(defaultCrewDoorStates(), 'e-qa-infrastructure', 'locked');
    expect(canCrewReachRoom('qa', 'infrastructure', locked)).toBe(false);
    expect(planCrewRoomTransfer('qa', 'infrastructure', locked)).toBeNull();
  });

  it('abrir la puerta de nuevo restaura la ruta, sin mutar el estado anterior', () => {
    const locked = setCrewDoorState(defaultCrewDoorStates(), 'e-qa-infrastructure', 'locked');
    const reopened = setCrewDoorState(locked, 'e-qa-infrastructure', 'open');
    expect(planCrewRoomTransfer('qa', 'infrastructure', locked)).toBeNull();
    expect(planCrewRoomTransfer('qa', 'infrastructure', reopened)).not.toBeNull();
  });

  it('una sala de origen igual a la de destino no cruza ninguna puerta', () => {
    const route = planCrewRoomTransfer('qa', 'qa');
    expect(route).not.toBeNull();
    expect(route!.doors).toEqual([]);
    expect(route!.segments).toHaveLength(1);
  });

  it('un id de sala desconocido no inventa una sala ni lanza', () => {
    expect(planCrewRoomTransfer('qa', 'sala-inexistente')).toBeNull();
    expect(canCrewReachRoom('sala-inexistente', 'qa')).toBe(false);
  });
});

describe('reserva exclusiva de silla/estación por sala (#129)', () => {
  it('dos agentes nunca ocupan la misma silla de una sala a la vez', () => {
    const room = crewRoom('development')!;
    const first = reserveCrewWorkstation({}, room, 'agent-a');
    const second = reserveCrewWorkstation(first.reservations, room, 'agent-b');
    expect(first.workstation).not.toBeNull();
    expect(second.workstation).not.toBeNull();
    expect(first.workstation!.chairId).not.toBe(second.workstation!.chairId);
    expect(crewWorkstationHolder(second.reservations, room.id, first.workstation!.chairId)).toBe('agent-a');
    expect(crewWorkstationHolder(second.reservations, room.id, second.workstation!.chairId)).toBe('agent-b');
  });

  it('reservar de nuevo para el mismo agente es idempotente: conserva su silla, no la duplica', () => {
    const room = crewRoom('ceo')!;
    const first = reserveCrewWorkstation({}, room, 'agent-a');
    const again = reserveCrewWorkstation(first.reservations, room, 'agent-a');
    expect(again.workstation).toEqual(first.workstation);
    expect(again.reservations).toEqual(first.reservations);
  });

  it('una sala sin estaciones libres niega la reserva en vez de desalojar al titular', () => {
    const room = crewRoom('ceo')!; // Dirección solo tiene un escritorio/silla.
    const first = reserveCrewWorkstation({}, room, 'agent-a');
    const second = reserveCrewWorkstation(first.reservations, room, 'agent-b');
    expect(second.workstation).toBeNull();
    expect(crewWorkstationHolder(second.reservations, room.id, first.workstation!.chairId)).toBe('agent-a');
  });

  it('liberar la silla de un agente inexistente no afecta a nadie (caso límite honesto)', () => {
    const room = crewRoom('ceo')!;
    const first = reserveCrewWorkstation({}, room, 'agent-a');
    const unchanged = releaseCrewWorkstation(first.reservations, room.id, 'agente-fantasma');
    expect(unchanged).toEqual(first.reservations);
  });

  it('liberar la silla de un agente real la deja disponible para otro', () => {
    const room = crewRoom('ceo')!;
    const first = reserveCrewWorkstation({}, room, 'agent-a');
    const freed = releaseCrewWorkstation(first.reservations, room.id, 'agent-a');
    const second = reserveCrewWorkstation(freed, room, 'agent-b');
    expect(second.workstation).not.toBeNull();
    expect(crewWorkstationHolder(second.reservations, room.id, second.workstation!.chairId)).toBe('agent-b');
  });

  it('salas distintas llevan reservas independientes: la misma silla id no coincide entre salas', () => {
    const ceo = crewRoom('ceo')!, finance = crewRoom('finance')!;
    let reservations: CrewWorkstationReservations = {};
    reservations = reserveCrewWorkstation(reservations, ceo, 'agent-a').reservations;
    reservations = reserveCrewWorkstation(reservations, finance, 'agent-b').reservations;
    expect(crewWorkstationHolder(reservations, ceo.id, 'ceo-chair')).toBe('agent-a');
    expect(crewWorkstationHolder(reservations, finance.id, 'finance-chair')).toBe('agent-b');
  });
});

describe('cobertura básica de las once salas reales (#129)', () => {
  it('toda sala del catálogo tiene al menos un nodo caminable para que la navegación nunca falle por falta de datos', () => {
    for (const room of CREW_ROOMS) {
      const walk = buildCrewWalkGraph(room);
      expect(walk.nodes.length).toBeGreaterThan(0);
    }
  });
});

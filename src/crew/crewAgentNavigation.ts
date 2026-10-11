import { crewAgentCollides } from './crewCollision';
import { crewRoom, type CrewRoomDefinition } from './crewModel';
import {
  buildCrewRoomGraph, buildCrewWalkGraph, defaultCrewDoorStates, findCrewRoomRoute, findCrewWalkPath,
  reachableCrewRooms, type CrewDoorStateMap, type CrewRoomGraph,
} from './crewRoutes';
import { crewWorkstations, type CrewWorkstation } from './crewActorActions';
import type { CrewLocalPoint } from './crewSpatial';

/**
 * Navegación de agentes Crew (#129): dentro de una sala y entre salas, construida
 * enteramente sobre las estructuras de datos que ya aportó #170 (`crewRoutes.ts`,
 * grafo de puertas y grafo caminable por sala) y #128 (ancla real de estación en
 * `crewActorActions.ts`). No reimplementa el BFS de puertas ni el de la grilla
 * caminable: solo los conecta y les agrega la reserva exclusiva de estación y una
 * verificación real de colisión contra mobiliario con `crewCollision.ts`. Capa
 * de datos pura; no dibuja nada ni mueve agentes del dominio.
 */

/** Un puñado de puntos a lo largo de cada tramo, suficiente para detectar un cruce real de mobiliario. */
function pathAvoidsFurniture(room: CrewRoomDefinition, path: readonly CrewLocalPoint[]): boolean {
  for (let i = 0; i < path.length; i++) {
    if (crewAgentCollides(room, path[i])) return false;
    if (i === 0) continue;
    const a = path[i - 1], b = path[i];
    for (const t of [0.25, 0.5, 0.75]) {
      if (crewAgentCollides(room, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
    }
  }
  return true;
}

/** Expuesto para que otros módulos (y las pruebas) verifiquen un tramo contra el mobiliario real de una sala. */
export function crewPathAvoidsFurniture(room: CrewRoomDefinition, path: readonly CrewLocalPoint[]): boolean {
  return pathAvoidsFurniture(room, path);
}

/**
 * Camino caminable dentro de una sola sala, reutilizando `buildCrewWalkGraph` y
 * `findCrewWalkPath` de #170 tal cual. `from`/`to` deben ser nodos reales del
 * grafo caminable de la sala (por ejemplo `crewPresenceSlots`/`arrivalPoints`),
 * el mismo contrato de precisión que ya exige `findCrewWalkPath`. Devuelve
 * `null` con honestidad ante una sala sin nodos caminables o un punto fuera del
 * grafo, en vez de inventar una ruta; nunca lanza.
 */
export function planCrewWalkWithinRoom(
  room: CrewRoomDefinition, from: CrewLocalPoint, to: CrewLocalPoint,
): readonly CrewLocalPoint[] | null {
  const walk = buildCrewWalkGraph(room);
  if (walk.nodes.length === 0) return null;
  const path = findCrewWalkPath(walk, from, to);
  if (!path) return null;
  // Defensa adicional con el módulo real de colisiones: el grafo caminable ya
  // evita el mobiliario, pero un agente nunca debe recibir una ruta que lo
  // atraviese, así que se reconfirma con `crewCollision.ts` antes de entregarla.
  return pathAvoidsFurniture(room, path) ? path : null;
}

/** Accesibilidad entre salas respetando puertas, reutilizando `reachableCrewRooms` de #170 tal cual. */
export function canCrewReachRoom(
  fromRoomId: string, toRoomId: string, doorStates: CrewDoorStateMap = defaultCrewDoorStates(), graph: CrewRoomGraph = buildCrewRoomGraph(),
): boolean {
  if (!(fromRoomId in graph)) return false;
  return reachableCrewRooms(graph, fromRoomId, doorStates).has(toRoomId);
}

export interface CrewRoomTransferSegment { roomId: string; path: readonly CrewLocalPoint[] }
export interface CrewRoomTransferRoute {
  rooms: readonly string[];
  doors: readonly string[];
  segments: readonly CrewRoomTransferSegment[];
}

/** Puerta de una sala cuyo enlace compartido (`edgeId`) coincide con el dado. */
function doorByEdge(room: CrewRoomDefinition, edgeId: string | undefined) {
  return edgeId === undefined ? undefined : room.doors.find(door => door.edgeId === edgeId);
}
function arrivalForDoor(room: CrewRoomDefinition, doorId: string | undefined) {
  return doorId === undefined ? undefined : room.arrivalPoints.find(arrival => arrival.doorId === doorId);
}

/**
 * Ruta real entre salas: usa `findCrewRoomRoute` (#170) para la secuencia de
 * salas y puertas respetando el estado abierto/cerrado, y por cada sala del
 * tramo calcula un camino caminable real de puerta de entrada a puerta de
 * salida (o el ancla de llegada única cuando es la primera/última sala),
 * nunca un teletransporte entre plantas. `null` cuando una puerta cerrada
 * separa las salas, cuando algún id de sala es desconocido o cuando alguna
 * sala del tramo no tiene cómo conectar sus propias puertas por su grafo
 * caminable interno.
 */
export function planCrewRoomTransfer(
  fromRoomId: string, toRoomId: string, doorStates: CrewDoorStateMap = defaultCrewDoorStates(), graph: CrewRoomGraph = buildCrewRoomGraph(),
): CrewRoomTransferRoute | null {
  const route = findCrewRoomRoute(graph, fromRoomId, toRoomId, doorStates);
  if (!route) return null;
  const segments: CrewRoomTransferSegment[] = [];
  for (let index = 0; index < route.rooms.length; index++) {
    const room = crewRoom(route.rooms[index]);
    if (!room) return null; // Dato inconsistente con el grafo: nunca inventar una sala.

    const exitDoorId = index < route.doors.length ? route.doors[index] : undefined;
    const exitDoor = exitDoorId === undefined ? undefined : room.doors.find(door => door.id === exitDoorId);
    const exitPoint = arrivalForDoor(room, exitDoor?.id);

    let entryPoint: CrewLocalPoint | undefined;
    if (index > 0) {
      const previousRoom = crewRoom(route.rooms[index - 1]);
      const previousExitDoor = previousRoom?.doors.find(door => door.id === route.doors[index - 1]);
      const entryDoor = doorByEdge(room, previousExitDoor?.edgeId ?? undefined);
      entryPoint = arrivalForDoor(room, entryDoor?.id);
    }

    const from = entryPoint ?? exitPoint ?? room.arrivalPoints[0];
    const to = exitPoint ?? entryPoint ?? room.arrivalPoints[0];
    if (!from || !to) return null; // Sala sin ningún punto de llegada real: nunca inventar coordenadas.
    const path = from.x === to.x && from.y === to.y ? [{ x: from.x, y: from.y }] : planCrewWalkWithinRoom(room, from, to);
    if (!path) return null;
    segments.push({ roomId: room.id, path });
  }
  return { rooms: route.rooms, doors: route.doors, segments };
}

/** silla/estación -> id del agente que la retiene ahora mismo, por sala. */
export type CrewWorkstationReservations = Readonly<Record<string, Readonly<Record<string, string>>>>;

export function crewWorkstationHolder(reservations: CrewWorkstationReservations, roomId: string, chairId: string): string | undefined {
  return reservations[roomId]?.[chairId];
}

export interface CrewWorkstationReservationResult {
  reservations: CrewWorkstationReservations;
  workstation: CrewWorkstation | null;
}

/**
 * Reserva pura y exclusiva de estación: dos agentes nunca retienen la misma
 * silla de una sala a la vez. Idempotente para quien ya tiene una en esa sala
 * (la conserva, nunca la reasigna ni la duplica); devuelve `workstation: null`
 * sin mutar nada cuando la sala no tiene ninguna estación libre.
 */
export function reserveCrewWorkstation(
  reservations: CrewWorkstationReservations, room: CrewRoomDefinition, agentId: string,
): CrewWorkstationReservationResult {
  const roomReservations = reservations[room.id] ?? {};
  const stations = crewWorkstations(room);

  const heldChairId = Object.entries(roomReservations).find(([, holder]) => holder === agentId)?.[0];
  if (heldChairId !== undefined) {
    const held = stations.find(station => station.chairId === heldChairId) ?? null;
    return { reservations, workstation: held };
  }

  const free = stations.find(station => !(station.chairId in roomReservations));
  if (!free) return { reservations, workstation: null };
  return {
    reservations: { ...reservations, [room.id]: { ...roomReservations, [free.chairId]: agentId } },
    workstation: free,
  };
}

/** Libera la silla que retiene un agente en una sala. Sin efecto (misma referencia) si no retenía ninguna. */
export function releaseCrewWorkstation(
  reservations: CrewWorkstationReservations, roomId: string, agentId: string,
): CrewWorkstationReservations {
  const roomReservations = reservations[roomId];
  if (!roomReservations) return reservations;
  const remaining = Object.fromEntries(Object.entries(roomReservations).filter(([, holder]) => holder !== agentId));
  if (Object.keys(remaining).length === Object.keys(roomReservations).length) return reservations;
  if (Object.keys(remaining).length === 0) {
    const { [roomId]: _dropped, ...rest } = reservations;
    return rest;
  }
  return { ...reservations, [roomId]: remaining };
}

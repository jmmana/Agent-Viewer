import type { CrewRoomDefinition, CrewView } from './crewModel';
import { CREW_PROP_SIZE } from './crewSpatial';
import { crewPolygon, type CrewPoint } from './crewRenderPrimitives';
import { CREW_PROP_SHADES } from './crewLightingLayer';

/**
 * Capa de props: dibuja cada mueble como una caja 2.5D con sus tres caras visibles
 * (frontal, lateral y superior), sombreadas por tipo mediante `crewLightingLayer`.
 * No decide posición ni orden de profundidad; eso lo resuelve el orquestador en
 * `renderCrewRoom` junto con los marcadores de presencia.
 */
export type CrewFurnitureItem = CrewRoomDefinition['furniture'][number];

/** Dibuja un mueble en un punto ya proyectado a coordenadas de sala (antes de isoPoint). */
export function drawCrewProp(ctx: CanvasRenderingContext2D, item: Pick<CrewFurnitureItem, 'type'>,
  x: number, y: number, view: CrewView, isoPoint: (x: number, y: number, z?: number) => CrewPoint): void {
  const size = CREW_PROP_SIZE[item.type];
  const sideView = view === 'left' || view === 'right';
  const w = sideView ? size.depth : size.width;
  const d = sideView ? size.width : size.depth;
  const h = size.height;
  const shade = CREW_PROP_SHADES[item.type];
  const b = isoPoint(x + w / 2, y - d / 2);
  const c = isoPoint(x + w / 2, y + d / 2), e = isoPoint(x - w / 2, y + d / 2);
  const at = isoPoint(x - w / 2, y - d / 2, h), bt = isoPoint(x + w / 2, y - d / 2, h);
  const ct = isoPoint(x + w / 2, y + d / 2, h), et = isoPoint(x - w / 2, y + d / 2, h);
  crewPolygon(ctx, [e, c, ct, et], shade.front);
  crewPolygon(ctx, [b, c, ct, bt], shade.side);
  crewPolygon(ctx, [at, bt, ct, et], shade.top);
}

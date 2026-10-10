import type { CrewRoomDefinition, CrewView } from './crewModel';
import { CREW_PROP_SIZE } from './crewSpatial';
import { crewPolygon, type CrewPoint } from './crewRenderPrimitives';
import { crewPropShades } from './crewLightingLayer';

/**
 * Capa de props: dibuja cada mueble como una caja 2.5D con sus tres caras visibles
 * (frontal, lateral y superior), sombreadas por tipo mediante `crewLightingLayer`.
 * No decide posición ni orden de profundidad; eso lo resuelve el orquestador en
 * `renderCrewRoom` junto con los marcadores de presencia.
 *
 * Piloto acotado de #115: cuando el orquestador resuelve una imagen real del banco
 * para este mueble (`CREW_ROOM_PROP_IMAGES`), se dibuja esa imagen como billboard
 * plano en vez de la caja; sigue siendo la MISMA imagen en las cuatro cámaras
 * porque el banco no tiene vistas verificadas por ángulo todavía (prototype).
 */
export type CrewFurnitureItem = CrewRoomDefinition['furniture'][number];
export interface CrewPropImageSpec {
  image: HTMLImageElement;
  width: number;
  height: number;
  displayHeight: number;
  anchor: { x: number; y: number };
}

/** Dibuja un mueble en un punto ya proyectado a coordenadas de sala (antes de isoPoint). */
export function drawCrewProp(ctx: CanvasRenderingContext2D, item: Pick<CrewFurnitureItem, 'type'>,
  x: number, y: number, view: CrewView, isoPoint: (x: number, y: number, z?: number) => CrewPoint,
  highContrast = false, propImage?: CrewPropImageSpec): void {
  if (propImage) {
    const point = isoPoint(x, y);
    const height = propImage.displayHeight, width = height * propImage.width / propImage.height;
    ctx.drawImage(propImage.image, point.x - width * propImage.anchor.x, point.y - height * propImage.anchor.y, width, height);
    return;
  }
  const size = CREW_PROP_SIZE[item.type];
  const sideView = view === 'left' || view === 'right';
  const w = sideView ? size.depth : size.width;
  const d = sideView ? size.width : size.depth;
  const h = size.height;
  const shade = crewPropShades(highContrast)[item.type];
  const b = isoPoint(x + w / 2, y - d / 2);
  const c = isoPoint(x + w / 2, y + d / 2), e = isoPoint(x - w / 2, y + d / 2);
  const at = isoPoint(x - w / 2, y - d / 2, h), bt = isoPoint(x + w / 2, y - d / 2, h);
  const ct = isoPoint(x + w / 2, y + d / 2, h), et = isoPoint(x - w / 2, y + d / 2, h);
  crewPolygon(ctx, [e, c, ct, et], shade.front);
  crewPolygon(ctx, [b, c, ct, bt], shade.side);
  crewPolygon(ctx, [at, bt, ct, et], shade.top);
}

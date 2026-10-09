import type { CrewCamera } from './crewCamera';
import { crewProject, type CrewRoomDefinition } from './crewModel';
import { crewFitScale, crewGeometryBounds, crewIsoPoint } from './renderCrewRoom';

type Viewport = { width: number; height: number };

/** Mantiene el centro de la sala dentro del viewport, incluso tras redimensionar. */
export function constrainCrewPan(camera: CrewCamera, viewport: Viewport): CrewCamera {
  const maxX = Math.max(0, viewport.width / 2 - 32);
  const maxY = Math.max(0, viewport.height / 2 - 32);
  const x = Math.max(-maxX, Math.min(maxX, camera.pan.x));
  const y = Math.max(-maxY, Math.min(maxY, camera.pan.y));
  return x === camera.pan.x && y === camera.pan.y ? camera : { ...camera, pan: { x, y } };
}

/** Enfoca únicamente un objeto existente en la sala elegida. */
export function focusCrewFurniture(camera: CrewCamera, room: CrewRoomDefinition, id: string, viewport: Viewport): CrewCamera {
  const item = room.furniture.find(candidate => candidate.id === id);
  if (!item) return camera;
  const anchor = crewProject(item.x, item.y, room, camera.view);
  const point = crewIsoPoint(anchor.x, anchor.y);
  const bounds = crewGeometryBounds(room, camera.view);
  const zoom = Math.max(camera.zoom, 1.5);
  const scale = crewFitScale(room, camera.view, viewport.width, viewport.height) * zoom;
  return constrainCrewPan({ ...camera, zoom, pan: {
    x: -(point.x - bounds.centerX) * scale,
    y: -(point.y - bounds.centerY) * scale,
  } }, viewport);
}

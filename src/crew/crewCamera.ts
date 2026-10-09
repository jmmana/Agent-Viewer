import { CREW_ROOMS, CREW_VIEWS, type CrewView } from './crewModel';

export interface CrewCamera {
  view: CrewView;
  zoom: number;
  pan: { x: number; y: number };
}
export type CrewCameraByRoom = Record<string, CrewCamera>;
export const CREW_CAMERA_STORAGE_KEY = 'agent-viewer-crew-camera-v1';

export function defaultCrewCamera(): CrewCamera {
  return { view: 'front', zoom: 1, pan: { x: 0, y: 0 } };
}
export function validateCrewCamera(value: unknown): CrewCamera | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const pan = c.pan as Record<string, unknown> | null;
  if (!CREW_VIEWS.includes(c.view as CrewView) || typeof c.zoom !== 'number'
    || !Number.isFinite(c.zoom) || c.zoom < .5 || c.zoom > 3
    || !pan || typeof pan.x !== 'number' || typeof pan.y !== 'number'
    || !Number.isFinite(pan.x) || !Number.isFinite(pan.y)
    || Math.abs(pan.x) > 5000 || Math.abs(pan.y) > 5000) return null;
  return { view: c.view as CrewView, zoom: c.zoom, pan: { x: pan.x, y: pan.y } };
}

export function parseCrewCameraStore(serialized: string | null): CrewCameraByRoom {
  if (!serialized || serialized.length > 10_000) return {};
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const state = value as Record<string, unknown>;
    const out: CrewCameraByRoom = {};
    for (const room of CREW_ROOMS) {
      const checked = validateCrewCamera(state[room.id]);
      if (checked) out[room.id] = checked;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Zoom around a pointer measured relative to the canvas center, keeping
 * the same world point under the cursor when changing the zoom factor.
 */
export function zoomCrewCameraAt(camera: CrewCamera, requestedZoom: number, cursorFromCenter: { x: number; y: number }): CrewCamera {
  const nextZoom = Math.max(.5, Math.min(3, requestedZoom));
  const ratio = nextZoom / camera.zoom;
  return {
    ...camera,
    zoom: nextZoom,
    pan: {
      x: cursorFromCenter.x - (cursorFromCenter.x - camera.pan.x) * ratio,
      y: cursorFromCenter.y - (cursorFromCenter.y - camera.pan.y) * ratio,
    },
  };
}

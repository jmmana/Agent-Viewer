import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CREW_ROOMS, CREW_VIEWS, type CrewView } from './crewModel';
import { renderCrewRoom } from './renderCrewRoom';
import { crewAgentsInRoom } from './crewEvents';
import { CrewGestures } from './crewGestures';
import type { Agent } from '../types/agent';
import { CREW_CAMERA_STORAGE_KEY, defaultCrewCamera, parseCrewCameraStore, zoomCrewCameraAt, type CrewCamera, type CrewCameraByRoom } from './crewCamera';

/**
 * Minimal independent Crew engine proof of concept. NOT a finished scene:
 * placeholders explicitly indicate missing approved multi-view artwork.
 * Neither the legacy renderer nor its office coordinates are imported.
 */
export function CrewStage({ locale = 'es', agents = [], selectedRoomId, onRoomChange }: {
  locale?: string;
  agents?: readonly Agent[];
  selectedRoomId?: string;
  onRoomChange?: (roomId: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gestures = useRef(new CrewGestures());
  const frameRef = useRef<number>(0);
  const [localRoomId, setLocalRoomId] = useState(CREW_ROOMS[0].id);
  const requestedRoom = selectedRoomId ?? localRoomId;
  const roomId = CREW_ROOMS.some(room => room.id === requestedRoom) ? requestedRoom : CREW_ROOMS[0].id;
  const setRoomId = (id: string) => { setLocalRoomId(id); onRoomChange?.(id); };
  // Persist ONLY presentation state, not domain events; each room remembers its own camera.
  const [cameraByRoom, setCameraByRoom] = useState<CrewCameraByRoom>(() => {
    if (typeof window === 'undefined') return {};
    try { return parseCrewCameraStore(window.localStorage.getItem(CREW_CAMERA_STORAGE_KEY)); }
    catch { return {}; }
  });
  const camera = cameraByRoom[roomId] ?? defaultCrewCamera();
  const { view, zoom } = camera;
  const patchCamera = (update: Partial<CrewCamera>) => setCameraByRoom(prev => ({
    ...prev, [roomId]: { ...(prev[roomId] ?? defaultCrewCamera()), ...update },
  }));
  const setView = (value: CrewView) => patchCamera({ view: value });
  const setZoom = (fn: (prev: number) => number) => patchCamera({ zoom: fn(zoom) });
  const updateCamera = useCallback((update: (camera: CrewCamera) => CrewCamera) => {
    setCameraByRoom(prev => ({ ...prev, [roomId]: update(prev[roomId] ?? defaultCrewCamera()) }));
  }, [roomId]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const reset = () => gestures.current.clear();
    reset();
    window.addEventListener('blur', reset);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = canvas!.getBoundingClientRect();
      const point = { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
      updateCamera(current => zoomCrewCameraAt(current, current.zoom * Math.exp(-event.deltaY * unit * .002), point));
    };
    canvas?.addEventListener('wheel', wheel, { passive: false });
    return () => {
      reset();
      window.removeEventListener('blur', reset);
      canvas?.removeEventListener('wheel', wheel);
    };
  }, [updateCamera]);
  const pointerPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
  };
  const endPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    gestures.current.end(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(CREW_CAMERA_STORAGE_KEY, JSON.stringify(cameraByRoom)); }
    catch { /* Read-only or disabled storage must not break rendering. */ }
  }, [cameraByRoom]);
  const isEs = locale.startsWith('es');
  const room = CREW_ROOMS.find(r => r.id === roomId)!;
  const visibleAgents = crewAgentsInRoom(agents, roomId);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(bounds.width * dpr);
    canvas.height = Math.round(bounds.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderCrewRoom({ ctx, width: bounds.width, height: bounds.height, room, camera, locale });
  }, [room, camera, locale]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(render) : null;
    observer?.observe(el);
    frameRef.current = requestAnimationFrame(render);
    return () => { observer?.disconnect(); cancelAnimationFrame(frameRef.current); };
  }, [render]);

  return <section aria-label={isEs ? 'Modo Crew: oficina independiente' : 'Crew mode: independent office'}
    style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#101a2b', color: '#f1f5f9' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', padding: 10, gap: 8, alignItems: 'center' }}>
      <label htmlFor="crew-room">{isEs ? 'Oficina' : 'Office'}</label>
      <select id="crew-room" value={roomId} onChange={e => setRoomId(e.target.value)}
        style={{ color: '#111827', background: '#fff', padding: 6 }}>
        {CREW_ROOMS.map(r => <option key={r.id} value={r.id}>{isEs ? r.label.es : r.label.en}</option>)}
      </select>
      <label htmlFor="crew-view">{isEs ? 'Cámara' : 'Camera'}</label>
      <select id="crew-view" value={view} onChange={e => setView(e.target.value as CrewView)}
        style={{ color: '#111827', background: '#fff', padding: 6 }}>
        {CREW_VIEWS.map(v => <option key={v} value={v}>{(isEs ? { front: 'Frente', right: 'Derecha', back: 'Atrás', left: 'Izquierda' } : { front: 'Front', right: 'Right', back: 'Back', left: 'Left' })[v]}</option>)}
      </select>
      <button type="button" onClick={() => setZoom(z => Math.max(.5, z / 1.2))} aria-label={isEs ? 'Alejar' : 'Zoom out'}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => setZoom(z => Math.min(3, z * 1.2))} aria-label={isEs ? 'Acercar' : 'Zoom in'}>+</button>
      <button type="button" onClick={() => patchCamera(defaultCrewCamera())}>
        {isEs ? 'Ajustar' : 'Fit room'}
      </button>
    </div>
    <div aria-live="polite" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 10px', fontSize: 12 }}>
      <span>{isEs ? 'Agentes en esta oficina:' : 'Agents in this room:'} {visibleAgents.length}</span>
      {visibleAgents.map(agent => <span key={agent.id} style={{ border: '1px solid #64748b', padding: '2px 6px', borderRadius: 6 }}>
        {agent.name}: {agent.status}
      </span>)}
    </div>
    <canvas ref={canvasRef} style={{ width: '100%', flex: 1, minHeight: 120, touchAction: 'none', cursor: 'grab' }}
      aria-label={isEs ? `Vista de oficina: ${room.label.es}` : `Office view: ${room.label.en}`}
      tabIndex={0}
      onKeyDown={event => {
        const directions: Record<string, { x: number; y: number }> = {
          ArrowLeft: { x: -32, y: 0 }, ArrowRight: { x: 32, y: 0 },
          ArrowUp: { x: 0, y: -32 }, ArrowDown: { x: 0, y: 32 },
        };
        if (directions[event.key]) {
          event.preventDefault();
          const delta = directions[event.key];
          updateCamera(current => ({ ...current, pan: { x: current.pan.x + delta.x, y: current.pan.y + delta.y } }));
        } else if (['+', '=', '-', 'Home'].includes(event.key)) {
          event.preventDefault();
          updateCamera(current => event.key === 'Home' ? defaultCrewCamera()
            : zoomCrewCameraAt(current, current.zoom * (event.key === '-' ? 1 / 1.2 : 1.2), { x: 0, y: 0 }));
        }
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        gestures.current.start(event.pointerId, pointerPoint(event));
      }}
      onPointerMove={event => {
        const update = gestures.current.move(event.pointerId, pointerPoint(event));
        if (update) updateCamera(update);
      }}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onLostPointerCapture={event => gestures.current.end(event.pointerId)}
    />
    <p style={{ padding: '6px 12px', margin: 0, fontSize: 12 }}>
      {isEs ? 'PROTOTIPO 2.5D: muebles y personajes finales pendientes' : '2.5D PROTOTYPE: final furniture and characters pending'}
    </p>
  </section>;
}

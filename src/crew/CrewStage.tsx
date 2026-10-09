import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CREW_ROOMS, CREW_VIEWS, type CrewView } from './crewModel';
import { renderCrewRoom } from './renderCrewRoom';
import { projectCrewPresence } from './crewPresence';
import { crewAgentsInRoom } from './crewEvents';
import { useCrewSprites } from './useCrewSprite';
import { crewSpriteView } from './crewSprites';
import { constrainCrewPan, focusCrewFurniture, focusCrewPoint } from './crewViewport';
import { crewRoomLink } from './crewNavigation';
import { CrewGestures } from './crewGestures';
import type { Agent } from '../types/agent';
import { CREW_CAMERA_STORAGE_KEY, defaultCrewCamera, parseCrewCameraStore, validateCrewCameraStore, zoomCrewCameraAt, type CrewCamera, type CrewCameraByRoom } from './crewCamera';

/**
 * Escena Crew independiente con arte incremental y geometría provisional.
 * Consume presencia del dominio sin importar el renderer ni la cuadrícula Caricatura.
 */
export function CrewStage({ locale = 'es', agents = [], selectedRoomId, onRoomChange, missingRoom = false,
  cameraState, onCameraStateChange, persistCamera = true, showRoomLink = true, idPrefix = 'crew' }: {
  locale?: string;
  agents?: readonly Agent[];
  selectedRoomId?: string;
  missingRoom?: boolean;
  cameraState?: CrewCameraByRoom;
  onCameraStateChange?: (cameras: CrewCameraByRoom) => void;
  persistCamera?: boolean;
  showRoomLink?: boolean;
  idPrefix?: string;
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
  const [internalCameras, setInternalCameras] = useState<CrewCameraByRoom>(() => {
    if (!persistCamera || cameraState !== undefined || typeof window === 'undefined') return {};
    try { return parseCrewCameraStore(window.localStorage.getItem(CREW_CAMERA_STORAGE_KEY)); }
    catch { return {}; }
  });
  const cameraByRoom = useMemo(() => cameraState === undefined ? internalCameras
    : validateCrewCameraStore(cameraState), [cameraState, internalCameras]);
  const cameraControl = useRef({ value: cameraByRoom, controlled: cameraState !== undefined, onChange: onCameraStateChange });
  cameraControl.current = { value: cameraByRoom, controlled: cameraState !== undefined, onChange: onCameraStateChange };
  const setCameraByRoom = useCallback((action: React.SetStateAction<CrewCameraByRoom>) => {
    const control = cameraControl.current;
    const next = typeof action === 'function' ? action(control.value) : action;
    if (next === control.value) return;
    if (!control.controlled) {
      control.value = next;
      setInternalCameras(next);
    }
    control.onChange?.(next);
  }, []);
  const camera = cameraByRoom[roomId] ?? defaultCrewCamera();
  const { view, zoom } = camera;
  const updateCamera = useCallback((update: (camera: CrewCamera) => CrewCamera) => {
    const viewport = canvasRef.current?.getBoundingClientRect();
    setCameraByRoom(prev => {
      const current = prev[roomId] ?? defaultCrewCamera();
      const next = update(viewport ? constrainCrewPan(current, viewport) : current);
      const constrained = viewport ? constrainCrewPan(next, viewport) : next;
      return constrained === current ? prev : { ...prev, [roomId]: constrained };
    });
  }, [roomId, setCameraByRoom]);
  const patchCamera = (update: Partial<CrewCamera>) => updateCamera(current => ({ ...current, ...update }));
  const setView = (value: CrewView) => patchCamera({ view: value });
  const setZoom = (fn: (prev: number) => number) => updateCamera(current => zoomCrewCameraAt(current, fn(current.zoom), { x: 0, y: 0 }));
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
    if (!persistCamera || typeof window === 'undefined') return;
    try { window.localStorage.setItem(CREW_CAMERA_STORAGE_KEY, JSON.stringify(cameraByRoom)); }
    catch { /* Read-only or disabled storage must not break rendering. */ }
  }, [cameraByRoom, persistCamera]);
  const isEs = locale.startsWith('es');
  const room = CREW_ROOMS.find(r => r.id === roomId)!;
  const visibleAgents = crewAgentsInRoom(agents, roomId);
  const presence = useMemo(() => projectCrewPresence(agents, room), [agents, room]);

  const spriteViews = presence.markers.flatMap(marker => crewSpriteView(marker, view) ?? []);
  const sprite = useCrewSprites(spriteViews);
  const drawnIllustrations = presence.markers.filter(marker => { const v = crewSpriteView(marker, view); return v && sprite.images[v]; }).length;

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
    renderCrewRoom({ ctx, width: bounds.width, height: bounds.height, room, camera: constrainCrewPan(camera, bounds), markers: presence.markers, sprites: sprite.images, locale });
  }, [room, camera, locale, presence, sprite.images]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      updateCamera(current => current);
      render();
    }) : null;
    observer?.observe(el);
    frameRef.current = requestAnimationFrame(render);
    return () => { observer?.disconnect(); cancelAnimationFrame(frameRef.current); };
  }, [render, updateCamera]);

  return <section aria-label={isEs ? 'Modo Crew: oficina independiente' : 'Crew mode: independent office'}
    style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflowY: 'auto', background: '#101a2b', color: '#f1f5f9' }}>
    {missingRoom && <p role="status" style={{ margin: 0, padding: '8px 12px' }}>
      {isEs ? 'La oficina del enlace no está disponible. Mostramos Dirección; puedes elegir otra oficina o volver a Caricatura.'
        : 'The linked office is unavailable. Showing CEO Office; choose another office or return to Cartoon.'}
    </p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', padding: 10, gap: 8, alignItems: 'center' }}>
      <label htmlFor={`${idPrefix}-room`}>{isEs ? 'Oficina' : 'Office'}</label>
      <select id={`${idPrefix}-room`} value={roomId} onChange={e => setRoomId(e.target.value)}
        style={{ color: '#111827', background: '#fff', padding: 6 }}>
        {CREW_ROOMS.map(r => <option key={r.id} value={r.id}>{isEs ? r.label.es : r.label.en}</option>)}
      </select>
      <label htmlFor={`${idPrefix}-view`}>{isEs ? 'Cámara' : 'Camera'}</label>
      <select id={`${idPrefix}-view`} value={view} onChange={e => setView(e.target.value as CrewView)}
        style={{ color: '#111827', background: '#fff', padding: 6 }}>
        {CREW_VIEWS.map(v => <option key={v} value={v}>{(isEs ? { front: 'Frente', right: 'Derecha', back: 'Atrás', left: 'Izquierda' } : { front: 'Front', right: 'Right', back: 'Back', left: 'Left' })[v]}</option>)}
      </select>
      <button type="button" onClick={() => setZoom(z => Math.max(.5, z / 1.2))} aria-label={isEs ? 'Alejar' : 'Zoom out'}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => setZoom(z => Math.min(3, z * 1.2))} aria-label={isEs ? 'Acercar' : 'Zoom in'}>+</button>
      <button type="button" onClick={() => patchCamera(defaultCrewCamera())}>
        {isEs ? 'Ajustar' : 'Fit room'}
      </button>
      <label htmlFor={`${idPrefix}-focus`}>{isEs ? 'Enfocar' : 'Focus'}</label>
      <select id={`${idPrefix}-focus`} value="" onChange={event => {
        const viewport = canvasRef.current?.getBoundingClientRect();
        const id = event.target.value;
        if (viewport) updateCamera(current => focusCrewFurniture(current, room, id, viewport));
      }} style={{ color: '#111827', background: '#fff', padding: 6, maxWidth: '100%' }}>
        <option value="">{isEs ? 'Elegir objeto' : 'Choose object'}</option>
        {room.furniture.filter(item => item.type === 'desk' || item.type === 'screen').map((item, index) =>
          <option key={item.id} value={item.id}>
            {item.type === 'desk' ? (isEs ? 'Escritorio' : 'Desk') : (isEs ? 'Monitor' : 'Monitor')} {index + 1}
          </option>)}
      </select>
      <button type="button" onClick={() => {
        gestures.current.clear();
        setCameraByRoom({});
        setRoomId(CREW_ROOMS[0].id);
      }}>{isEs ? 'Restablecer Crew' : 'Reset Crew preferences'}</button>
      {showRoomLink && typeof window !== 'undefined' && <a href={crewRoomLink(window.location.href, roomId)}>
        {isEs ? 'Enlace a esta oficina' : 'Link to this office'}
      </a>}
    </div>
    <div aria-live="polite" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 10px', fontSize: 12, maxHeight: 96, overflowY: 'auto', flexShrink: 0 }}>
      <span>{isEs ? 'Agentes en esta oficina:' : 'Agents in this room:'} {visibleAgents.length}</span>
      {visibleAgents.map(agent => {
        const marker = presence.markers.find(item => item.id === agent.id);
        return <button type="button" key={agent.id} disabled={!marker}
          aria-label={isEs ? `Enfocar a ${agent.name}` : `Focus ${agent.name}`}
          onClick={() => {
            const viewport = canvasRef.current?.getBoundingClientRect();
            if (marker && viewport) updateCamera(current => focusCrewPoint(current, room, marker, viewport));
          }} style={{ border: '1px solid #64748b', padding: '2px 6px', borderRadius: 6 }}>
          {marker && <span aria-hidden="true">{marker.number}. </span>}
          <span>{agent.name}: {agent.status}</span>
        </button>;
      })}
      {presence.unplaced.length > 0 && <span role="status">{isEs
        ? `${presence.unplaced.length} agentes sin espacio de representación en esta sala.`
        : `${presence.unplaced.length} agents have no available display position in this room.`}</span>}
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
    <p aria-live="polite" data-testid="crew-art-status" style={{ padding: '4px 12px', margin: 0, fontSize: 12 }}>
      {isEs ? `Ilustraciones estáticas: ${drawnIllustrations}.` : `Static illustrations: ${drawnIllustrations}.`}
      {sprite.failed && (isEs ? ' No se pudo cargar la imagen; se conserva el marcador.' : ' Image unavailable; the marker remains visible.')}
    </p>
    <p style={{ padding: '6px 12px', margin: 0, fontSize: 12 }}>
      {isEs ? 'PROTOTIPO 2.5D: poses estáticas del CEO y marcadores de presencia; animaciones pendientes.' : '2.5D PROTOTYPE: static CEO poses and presence markers; animations pending.'}
    </p>
  </section>;
}

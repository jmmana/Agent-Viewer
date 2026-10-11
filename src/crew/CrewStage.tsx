import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CREW_ROOMS, CREW_VIEWS, type CrewView } from './crewModel';
import { CrewRoomSelector } from './CrewRoomSelector';
import { renderCrewRoom } from './renderCrewRoom';
import { projectCrewPresence } from './crewPresence';
import { crewAgentsInRoom } from './crewEvents';
import { useCrewSprites } from './useCrewSprite';
import { crewSpriteView } from './crewSprites';
import { useCrewBlink } from './useCrewBlink';
import { useCrewActions } from './useCrewActions';
import { crewActionMarkers } from './crewActorActions';
import { useCrewWalk } from './useCrewWalk';
import { preloadCrewWalk } from './crewWalkRegistry';
import { builtInMessages } from '../content/officeMessages';
import { constrainCrewPan, focusCrewFurniture, focusCrewPoint } from './crewViewport';
import { crewRoomLink } from './crewNavigation';
import {
  applyCrewAccessibilityPreset,
  defaultCrewPreferences,
  validateCrewPreferences,
  CREW_HUD_SCALE,
  type CrewAccessibilityPreset,
  type CrewHudSize,
  type CrewPreferences,
} from './crewPreferences';
import { crewTheme } from './crewContrast';
import { CrewGestures } from './crewGestures';
import { crewAgentActivity, crewActivityLine, crewViewerModeLabel, type CrewViewerMode, type CrewVisibility } from './crewEventBridge';
import type { Agent, Meeting, Task } from '../types/agent';
import { CREW_CAMERA_STORAGE_KEY, defaultCrewCamera, parseCrewCameraStore, validateCrewCameraStore, zoomCrewCameraAt, type CrewCamera, type CrewCameraByRoom } from './crewCamera';

/** Oculta visualmente un texto sin quitarlo de la lectura por lector de pantalla. */
const srOnlyStyle: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
};

/**
 * Escena Crew independiente con arte incremental y geometría provisional.
 * Consume presencia del dominio sin importar el renderer ni la cuadrícula Caricatura.
 */
export function CrewStage({ locale = 'es', agents = [], tasks = [], meetings = [], viewerMode, visibility = 'full',
  selectedRoomId, onRoomChange, missingRoom = false,
  cameraState, onCameraStateChange, preferences, onPreferencesChange, persistCamera = true, showRoomLink = true, idPrefix = 'crew' }: {
  locale?: string;
  agents?: readonly Agent[];
  /** Tareas del snapshot (issue #155). Solo lectura: Crew nunca recalcula su estado ni su progreso. */
  tasks?: readonly Task[];
  /** Reuniones del snapshot (issue #155). Solo lectura, igual que `tasks`. */
  meetings?: readonly Meeting[];
  /**
   * LIVE/DEMO/REPLAY explícito del host (issue #155). Sin esta prop, Crew no muestra ninguna insignia:
   * nunca infiere el modo a partir de los datos.
   */
  viewerMode?: CrewViewerMode;
  /** `full` (por defecto) o `minimized` para pantallas públicas/televisores: oculta texto de tarea y reunión. */
  visibility?: CrewVisibility;
  selectedRoomId?: string;
  missingRoom?: boolean;
  cameraState?: CrewCameraByRoom;
  onCameraStateChange?: (cameras: CrewCameraByRoom) => void;
  preferences?: CrewPreferences;
  onPreferencesChange?: (preferences: CrewPreferences) => void;
  persistCamera?: boolean;
  showRoomLink?: boolean;
  idPrefix?: string;
  onRoomChange?: (roomId: string) => void;
}) {
  const [internalPreferences, setInternalPreferences] = useState(defaultCrewPreferences);
  const visualPreferences = validateCrewPreferences(preferences ?? internalPreferences);
  const changePreferences = (value: CrewPreferences) => {
    if (preferences === undefined) setInternalPreferences(value);
    onPreferencesChange?.(value);
  };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gestures = useRef(new CrewGestures());
  const frameRef = useRef<number>(0);
  const [localRoomId, setLocalRoomId] = useState(CREW_ROOMS[0].id);
  const requestedRoom = selectedRoomId ?? localRoomId;
  const roomId = CREW_ROOMS.some(room => room.id === requestedRoom) ? requestedRoom : CREW_ROOMS[0].id;
  // Subtítulos (#157): texto equivalente a cualquier aviso de cambio de sala/cámara,
  // útil para quien no escucha audio o lo tiene desactivado. No depende de audio real.
  const captionId = useRef(0);
  const [captions, setCaptions] = useState<{ id: number; text: string }[]>([]);
  const pushCaption = useCallback((text: string) => {
    captionId.current += 1;
    setCaptions(prev => [...prev.slice(-2), { id: captionId.current, text }]);
  }, []);
  const setRoomId = (id: string) => {
    setLocalRoomId(id);
    onRoomChange?.(id);
    const nextRoom = CREW_ROOMS.find(item => item.id === id);
    if (nextRoom) pushCaption(isEs ? `Sala: ${nextRoom.label.es}` : `Office: ${nextRoom.label.en}`);
  };
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
  const setView = (value: CrewView) => {
    // Precarga solo el ángulo elegido para actores que ya reportan caminar.
    if (!visualPreferences.reducedMotion && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const facings=new Set(presence.markers.filter(marker=>agents.some(agent=>agent.id===marker.id && agent.isWalking))
        .map(marker=>crewSpriteView(marker,value)).filter((facing):facing is CrewView=>facing!==null));
      for (const facing of facings) void preloadCrewWalk(facing).catch(()=>undefined);
    }
    patchCamera({ view: value });
    const label = isEs
      ? { front: 'Frente', right: 'Derecha', back: 'Atrás', left: 'Izquierda' }
      : { front: 'Front', right: 'Right', back: 'Back', left: 'Left' };
    pushCaption(isEs ? `Cámara: ${label[value]}` : `Camera: ${label[value]}`);
  };
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
  const visibleAgents = useMemo(() => crewAgentsInRoom(agents, roomId), [agents, roomId]);
  const action = useCrewActions(visibleAgents, room, view, visualPreferences.reducedMotion);
  const presence = useMemo(() => {
    const projected = projectCrewPresence(agents, room);
    return { ...projected, markers: crewActionMarkers(projected.markers, action.actions) };
  }, [agents, room, action.actions]);

  const directions = presence.markers.map(marker => crewSpriteView(marker, view)).filter((direction): direction is CrewView => direction !== null);
  const sprite = useCrewSprites(directions);
  const illustratedAgents = directions.filter(direction => !!sprite.images[direction]).length;
  const walkingMarkers = useMemo(()=>presence.markers.filter(marker=>agents.some(agent=>agent.id===marker.id && agent.isWalking)),[presence.markers,agents]);
  const blink = useCrewBlink(presence.markers.some(marker=>crewSpriteView(marker,view)==='front'
    && !walkingMarkers.includes(marker)) && !!sprite.images.front, roomId, visualPreferences.reducedMotion);
  const walkDirections = walkingMarkers.map(marker=>crewSpriteView(marker,view)).filter((direction): direction is CrewView=>direction!==null);
  const walk = useCrewWalk(walkDirections,roomId,visualPreferences.reducedMotion);
  const walks = useMemo(()=>Object.fromEntries(walkingMarkers.map(marker=>{
    const direction=crewSpriteView(marker,view);
    return [marker.id,direction ? walk.frames[direction] : undefined];
  })),[walkingMarkers,view,walk.frames]);
  const messages = builtInMessages(locale);

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
    renderCrewRoom({ ctx, width: bounds.width, height: bounds.height, room, camera: constrainCrewPan(camera, bounds), markers: presence.markers, sprites: sprite.images, blink, walks, actions: action.frames, locale, highContrast: visualPreferences.highContrast });
  }, [room, camera, locale, presence, sprite.images, blink, walks, action.frames, visualPreferences.highContrast]);

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

  const theme = crewTheme(visualPreferences.highContrast);
  const hudScale = CREW_HUD_SCALE[visualPreferences.hudSize];
  return <section aria-label={isEs ? 'Modo Crew: oficina independiente' : 'Crew mode: independent office'}
    style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflowY: 'auto', background: theme.background, color: theme.text }}>
    {missingRoom && <p role="status" style={{ margin: 0, padding: '8px 12px' }}>
      {isEs ? 'La oficina del enlace no está disponible. Mostramos Dirección; puedes elegir otra oficina o volver a Caricatura.'
        : 'The linked office is unavailable. Showing CEO Office; choose another office or return to Cartoon.'}
    </p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', padding: 10 * hudScale, gap: 8 * hudScale, alignItems: 'center', fontSize: 14 * hudScale }}>
      {viewerMode && <span data-testid={`${idPrefix}-viewer-mode`}
        aria-label={isEs ? `Modo: ${crewViewerModeLabel(viewerMode, isEs)}` : `Mode: ${crewViewerModeLabel(viewerMode, isEs)}`}
        style={{ border: '1px solid currentColor', borderRadius: 999, padding: '2px 8px', fontSize: 11 * hudScale, fontWeight: 700, letterSpacing: .4 }}>
        {crewViewerModeLabel(viewerMode, isEs)}
      </span>}
      <CrewRoomSelector roomId={roomId} onChange={setRoomId} agents={agents} isEs={isEs} idPrefix={idPrefix} />
      <button type="button" disabled={roomId === CREW_ROOMS[0].id}
        onClick={() => setRoomId(CREW_ROOMS[Math.max(0, CREW_ROOMS.findIndex(item => item.id === roomId) - 1)].id)}>
        {isEs ? 'Oficina anterior' : 'Previous office'}
      </button>
      <button type="button" disabled={roomId === CREW_ROOMS[CREW_ROOMS.length - 1].id}
        onClick={() => setRoomId(CREW_ROOMS[Math.min(CREW_ROOMS.length - 1, CREW_ROOMS.findIndex(item => item.id === roomId) + 1)].id)}>
        {isEs ? 'Oficina siguiente' : 'Next office'}
      </button>
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
        changePreferences(defaultCrewPreferences());
        setRoomId(CREW_ROOMS[0].id);
      }}>{isEs ? 'Restablecer Crew' : 'Reset Crew preferences'}</button>
      <label htmlFor={`${idPrefix}-reduced-motion`}><input id={`${idPrefix}-reduced-motion`} type="checkbox" checked={visualPreferences.reducedMotion}
        onChange={event => changePreferences({ ...visualPreferences, reducedMotion: event.target.checked })} />
        {isEs ? 'Reducir movimiento' : 'Reduce motion'}
      </label>
      {showRoomLink && typeof window !== 'undefined' && <a href={crewRoomLink(window.location.href, roomId)}>
        {isEs ? 'Enlace a esta oficina' : 'Link to this office'}
      </a>}
    </div>
    {/* Colapsado por defecto: deja la barra principal utilizable en móvil
      (320-390px) sin empujar el canvas fuera del viewport. <details>/<summary>
      es nativamente operable con teclado (Enter/Espacio) y expone su estado
      abierto/cerrado a lectores de pantalla sin JavaScript adicional. */}
    <details style={{ padding: `0 ${12 * hudScale}px` }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 * hudScale, padding: `${4 * hudScale}px 0` }}>
        {isEs ? 'Accesibilidad y audio de Crew' : 'Crew accessibility and audio'}
      </summary>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 * hudScale, alignItems: 'center', padding: `${4 * hudScale}px 0`, fontSize: 13 * hudScale }}>
        <label htmlFor={`${idPrefix}-high-contrast`}><input id={`${idPrefix}-high-contrast`} type="checkbox" checked={visualPreferences.highContrast}
          onChange={event => changePreferences({ ...visualPreferences, highContrast: event.target.checked })} />
          {isEs ? 'Alto contraste' : 'High contrast'}
        </label>
        <label htmlFor={`${idPrefix}-subtitles`}><input id={`${idPrefix}-subtitles`} type="checkbox" checked={visualPreferences.subtitles}
          onChange={event => changePreferences({ ...visualPreferences, subtitles: event.target.checked })} />
          {isEs ? 'Subtítulos de cambios de sala y cámara' : 'Room and camera change captions'}
        </label>
        <label htmlFor={`${idPrefix}-muted`}><input id={`${idPrefix}-muted`} type="checkbox" checked={visualPreferences.muted}
          onChange={event => changePreferences({ ...visualPreferences, muted: event.target.checked })} />
          {isEs ? 'Silenciar audio de Crew' : 'Mute Crew audio'}
        </label>
        <label htmlFor={`${idPrefix}-volume`}>{isEs ? 'Volumen de Crew' : 'Crew volume'}</label>
        <input id={`${idPrefix}-volume`} type="range" min={0} max={1} step={0.05}
          value={visualPreferences.volume} disabled={visualPreferences.muted}
          aria-valuetext={`${Math.round(visualPreferences.volume * 100)}%`}
          onChange={event => changePreferences({ ...visualPreferences, volume: Number(event.target.value) })} />
        <span aria-hidden="true">{Math.round(visualPreferences.volume * 100)}%</span>
        <label htmlFor={`${idPrefix}-hud-size`}>{isEs ? 'Tamaño de controles' : 'Controls size'}</label>
        <select id={`${idPrefix}-hud-size`} value={visualPreferences.hudSize}
          onChange={event => changePreferences({ ...visualPreferences, hudSize: event.target.value as CrewHudSize })}
          style={{ color: '#111827', background: '#fff', padding: 6 }}>
          <option value="compact">{isEs ? 'Compacto' : 'Compact'}</option>
          <option value="standard">{isEs ? 'Estándar' : 'Standard'}</option>
          <option value="large">{isEs ? 'Grande' : 'Large'}</option>
        </select>
        <label htmlFor={`${idPrefix}-a11y-preset`}>{isEs ? 'Preset de accesibilidad' : 'Accessibility preset'}</label>
        <select id={`${idPrefix}-a11y-preset`} value={visualPreferences.accessibilityPreset}
          onChange={event => changePreferences(applyCrewAccessibilityPreset(visualPreferences, event.target.value as CrewAccessibilityPreset))}
          style={{ color: '#111827', background: '#fff', padding: 6 }}>
          <option value="none">{isEs ? 'Ninguno' : 'None'}</option>
          <option value="screenReader">{isEs ? 'Lector de pantalla' : 'Screen reader'}</option>
          <option value="lowVision">{isEs ? 'Baja visión' : 'Low vision'}</option>
        </select>
      </div>
      <p style={{ margin: '2px 0', fontSize: 11 * hudScale, opacity: .85 }}>
        {isEs ? 'Aún no existe un motor de audio propio de Crew (#150): mute/volumen quedan listos pero sin sonido que controlar.'
          : 'Crew has no audio engine yet (#150): mute/volume are wired but there is no sound to control.'}
      </p>
    </details>
    {/* aria-live sin role explícito, igual que el listado de agentes de abajo:
      evita chocar con el único role="status" del aviso de sala inexistente.
      Sin texto que anunciar, no reserva alto incluso con subtítulos activos. */}
    <div aria-live="polite" data-crew-captions="true" data-testid={`${idPrefix}-captions`}
      style={visualPreferences.subtitles && captions.length > 0
        ? { padding: '2px 12px', margin: 0, fontSize: 12 * hudScale }
        : srOnlyStyle}>
      {captions.map(caption => <p key={caption.id} style={{ margin: 0 }}>{caption.text}</p>)}
    </div>
    <div aria-live="polite" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 10px', fontSize: 12, maxHeight: 96, overflowY: 'auto', flexShrink: 0 }}>
      {visibleAgents.length === 0 && <span>{isEs ? 'Oficina vacía. El mobiliario sigue disponible.' : 'Empty office. Furniture remains visible.'}</span>}
      <span>{isEs ? 'Agentes en esta oficina:' : 'Agents in this room:'} {visibleAgents.length}</span>
      {visibleAgents.map(agent => {
        const marker = presence.markers.find(item => item.id === agent.id);
        // Puente de eventos de solo lectura (#155): la misma actividad real del snapshot (tarea, reunión,
        // aprobación, herramienta) sin inventar nada ni recalcular tokens/costo.
        const activity = crewAgentActivity(agent, tasks, meetings, visibility);
        const activityLine = crewActivityLine(activity, isEs);
        return <button type="button" key={agent.id} disabled={!marker}
          aria-label={isEs ? `Enfocar a ${agent.name}` : `Focus ${agent.name}`}
          onClick={() => {
            const viewport = canvasRef.current?.getBoundingClientRect();
            if (marker && viewport) updateCamera(current => focusCrewPoint(current, room, marker, viewport));
          }} style={{ border: '1px solid #64748b', padding: '2px 6px', borderRadius: 6 }}>
          {marker && <span aria-hidden="true">{marker.number}. </span>}
          <span>{agent.name}: {agent.status}</span>
          {agent.isWalking && <span>{isEs ? ' · En tránsito' : ' · In transit'}</span>}
          {activityLine && <span> · {activityLine}</span>}
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
      {isEs ? `Ilustraciones: ${illustratedAgents}.` : `Illustrations: ${illustratedAgents}.`}
      {!sprite.failed && directions.some(direction => !sprite.images[direction]) && (isEs ? ' Cargando ilustraciones…' : ' Loading illustrations…')}
      {sprite.failed && (isEs ? ' No se pudo cargar la imagen; se conserva el marcador.' : ' Image unavailable; the marker remains visible.')}
      {action.failed && <span data-testid="crew-action-fallback"> {messages['crew.actionFallback']}</span>}
      {walk.failed && <span data-testid="crew-walk-fallback"> {messages['crew.walkFallback']}</span>}
    </p>
    <p style={{ padding: '6px 12px', margin: 0, fontSize: 12 }}>
      {messages['crew.walkPrototype']}
    </p>
  </section>;
}

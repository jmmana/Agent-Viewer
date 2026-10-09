import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CREW_ROOMS, CREW_VIEWS, type CrewView } from './crewModel';
import { renderCrewRoom } from './renderCrewRoom';
import { crewAgentsInRoom } from './crewEvents';
import type { Agent } from '../types/agent';
import { CREW_CAMERA_STORAGE_KEY, defaultCrewCamera, parseCrewCameraStore, type CrewCamera, type CrewCameraByRoom } from './crewCamera';

/**
 * Minimal independent Crew engine proof of concept. NOT a finished scene:
 * placeholders explicitly indicate missing approved multi-view artwork.
 * Neither the legacy renderer nor its office coordinates are imported.
 */
export function CrewStage({ locale = 'es', agents = [] }: { locale?: string; agents?: readonly Agent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const [roomId, setRoomId] = useState(CREW_ROOMS[0].id);
  // Persist ONLY presentation state, not domain events; each room remembers its own camera.
  const [cameraByRoom, setCameraByRoom] = useState<CrewCameraByRoom>(() => {
    if (typeof window === 'undefined') return {};
    try { return parseCrewCameraStore(window.localStorage.getItem(CREW_CAMERA_STORAGE_KEY)); }
    catch { return {}; }
  });
  const camera = cameraByRoom[roomId] ?? defaultCrewCamera();
  const { view, zoom, pan } = camera;
  const patchCamera = (update: Partial<CrewCamera>) => setCameraByRoom(prev => ({
    ...prev, [roomId]: { ...(prev[roomId] ?? defaultCrewCamera()), ...update },
  }));
  const setView = (value: CrewView) => patchCamera({ view: value });
  const setZoom = (fn: (prev: number) => number) => patchCamera({ zoom: fn(zoom) });
  const setPan = (fn: (prev: { x: number; y: number }) => { x: number; y: number }) => patchCamera({ pan: fn(pan) });
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

  return <section aria-label={isEs ? 'Modo Crew — oficina independiente' : 'Crew mode — independent office'}
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
        {CREW_VIEWS.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
      <button type="button" onClick={() => setZoom(z => Math.max(.5, z / 1.2))} aria-label="Zoom out">−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => setZoom(z => Math.min(3, z * 1.2))} aria-label="Zoom in">+</button>
      <button type="button" onClick={() => patchCamera(defaultCrewCamera())}>
        {isEs ? 'Ajustar' : 'Fit room'}
      </button>
    </div>
    <div aria-live="polite" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 10px', fontSize: 12 }}>
      <span>{isEs ? 'Agentes reales en esta oficina:' : 'Actual agents in this room:'} {visibleAgents.length}</span>
      {visibleAgents.map(agent => <span key={agent.id} style={{ border: '1px solid #64748b', padding: '2px 6px', borderRadius: 6 }}>
        {agent.name}: {agent.status}
      </span>)}
    </div>
    <canvas ref={canvasRef} style={{ width: '100%', flex: 1, minHeight: 120, touchAction: 'none', cursor: 'grab' }}
      aria-label={isEs ? `Vista de oficina: ${room.label.es}` : `Office view: ${room.label.en}`}
      onWheel={e => { e.preventDefault(); setZoom(z => Math.max(.5, Math.min(3, z * (e.deltaY < 0 ? 1.1 : .9)))); }}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.px = String(e.clientX); e.currentTarget.dataset.py = String(e.clientY); }}
      onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const px = Number(e.currentTarget.dataset.px || e.clientX), py = Number(e.currentTarget.dataset.py || e.clientY); setPan(p => ({ x: p.x + e.clientX - px, y: p.y + e.clientY - py })); e.currentTarget.dataset.px = String(e.clientX); e.currentTarget.dataset.py = String(e.clientY); }}
      onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
    />
  </section>;
}

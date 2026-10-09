import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CREW_ROOMS, CREW_VIEWS, crewProject, type CrewView } from './crewModel';
import { CREW_CAMERA_STORAGE_KEY, defaultCrewCamera, parseCrewCameraStore, type CrewCamera, type CrewCameraByRoom } from './crewCamera';

/**
 * Minimal independent Crew engine proof of concept. NOT a finished scene:
 * placeholders explicitly indicate missing approved multi-view artwork.
 * Neither the legacy renderer nor its office coordinates are imported.
 */
export function CrewStage({ locale = 'es' }: { locale?: string }) {
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
    ctx.scale(dpr, dpr);
    const w = bounds.width, h = bounds.height;
    ctx.fillStyle = '#172136';
    ctx.fillRect(0, 0, w, h);
    const flip = view === 'right' || view === 'left';
    const roomW = (flip ? room.depth : room.width) * 50;
    const roomH = (flip ? room.width : room.depth) * 50;
    const base = Math.min((w - 48) / roomW, (h - 88) / roomH, 2.2);
    ctx.translate(w / 2 + pan.x, h / 2 + pan.y);
    ctx.scale(base * zoom, base * zoom);
    ctx.translate(-roomW / 2, -roomH / 2);

    // The room has its own world, walls and camera-projected geometry.
    ctx.fillStyle = '#c9bdab'; ctx.fillRect(0, 0, roomW, roomH);
    ctx.strokeStyle = '#bdad98'; ctx.lineWidth = 1.2;
    for (let x = 0; x <= roomW; x += 50) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, roomH); ctx.stroke();
    }
    for (let y = 0; y <= roomH; y += 50) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(roomW, y); ctx.stroke();
    }
    ctx.fillStyle = '#748aa0';
    // Cutaway walls: choose wall pairs by camera preset instead of rotating a flat screenshot.
    ctx.fillRect(0, 0, roomW, 14);
    ctx.fillRect(0, 0, 14, roomH);
    ctx.fillStyle = '#a8bed2';
    ctx.fillRect(roomW * 0.3, 2, roomW * 0.36, 10);

    const projected = room.furniture.map(item => ({ ...item, ...crewProject(item.x, item.y, room, view) }));
    for (const item of projected.sort((a, b) => a.y - b.y)) {
      const x = item.x * 50, y = item.y * 50;
      ctx.fillStyle = item.type === 'desk' ? '#78543b'
        : item.type === 'chair' ? '#4a6689'
        : item.type === 'plant' ? '#277f60' : '#24334b';
      const size = item.type === 'desk' ? 46 : item.type === 'screen' ? 32 : 24;
      ctx.beginPath(); ctx.roundRect(x - size / 2, y - size / 2, size, size * .72, 5); ctx.fill();
      if (item.type === 'screen') {
        ctx.fillStyle = '#35b7c9'; ctx.fillRect(x - 11, y - 8, 22, 10);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#e2e8f0'; ctx.font = '12px sans-serif';
    ctx.fillText(isEs ? 'PROTOTIPO · arte final pendiente' : 'PROTOTYPE · final artwork pending', 12, h - 14);
  }, [room, view, zoom, pan, isEs]);

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
    <canvas ref={canvasRef} style={{ width: '100%', flex: 1, minHeight: 120, touchAction: 'none', cursor: 'grab' }}
      aria-label={isEs ? `Vista de oficina: ${room.label.es}` : `Office view: ${room.label.en}`}
      onWheel={e => { e.preventDefault(); setZoom(z => Math.max(.5, Math.min(3, z * (e.deltaY < 0 ? 1.1 : .9)))); }}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.px = String(e.clientX); e.currentTarget.dataset.py = String(e.clientY); }}
      onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const px = Number(e.currentTarget.dataset.px || e.clientX), py = Number(e.currentTarget.dataset.py || e.clientY); setPan(p => ({ x: p.x + e.clientX - px, y: p.y + e.clientY - py })); e.currentTarget.dataset.px = String(e.clientX); e.currentTarget.dataset.py = String(e.clientY); }}
      onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
    />
  </section>;
}

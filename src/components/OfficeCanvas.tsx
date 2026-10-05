import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Agent } from '../types/agent';
import { CameraState, renderOfficeScene } from '../engine/canvasRenderer';
import { getOfficeRenderedBounds, gridToScreen } from '../engine/officeModel';
import { OfficeMotion } from '../engine/visualMotion';
import { cameraCenter } from '../engine/visualLayout';
import {
  ZoomIn,
  ZoomOut,
  Radio,
  Focus,
  RotateCw,
  RotateCcw,
} from 'lucide-react';

interface OfficeCanvasProps {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  activeMeetingId: string | null;
  theme: 'dark' | 'light';
  isInspectorOpen?: boolean;
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
}

export const OfficeCanvas: React.FC<OfficeCanvasProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  activeMeetingId,
  theme,
  isInspectorOpen = false,
  onToggleSidebar,
  isSidebarOpen = false,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionRef = useRef(new OfficeMotion());
  const visibleAgentsRef = useRef<Agent[]>(agents);
  const dragDistanceRef = useRef(0);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  // Camera State with 4-way rotation
  const [camera, setCamera] = useState<CameraState>({
    x: 0,
    y: 0,
    zoom: 1.1,
    rotation: 0, // 0: SE, 1: SW, 2: NW, 3: NE
  });

  const isDraggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);

  /**
   * Fit-to-View: Dynamically calculates the rendered world bounding box of all
   * office elements and scales/centers the office to occupy 78–84% of the visible canvas.
   */
  const fitOfficeToViewport = useCallback(
    (rotOverride?: number) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const availableWidth = rect.width;
      const availableHeight = rect.height;
      if (availableWidth <= 0 || availableHeight <= 0) return;

      const currentRot = rotOverride !== undefined ? rotOverride : camera.rotation;

      // Calculate exact rendered screen bounds for the current rotation
      const bounds = getOfficeRenderedBounds(currentRot);

      // Usable area without clutter overlays so the office map grows much larger
      const topPadding = 12;
      const bottomPadding = 48;
      const horizontalPadding = 16;

      const usableWidth = Math.max(availableWidth - horizontalPadding * 2, 100);
      const usableHeight = Math.max(availableHeight - topPadding - bottomPadding, 100);

      // Office occupies ~94% of the usable canvas area to fill the screen
      const targetCoverage = 0.94;

      const scaleX = (usableWidth * targetCoverage) / bounds.width;
      const scaleY = (usableHeight * targetCoverage) / bounds.height;

      // Uniform scale preserving proportions
      const targetZoom = Math.min(scaleX, scaleY);
      const clampedZoom = Math.min(Math.max(targetZoom, 0.15), 2.5);

      // Center exactly on the bounding box center point
      setCamera((prev) => ({
        ...prev,
        x: -bounds.centerX,
        y: -bounds.centerY,
        zoom: clampedZoom,
        rotation: currentRot,
      }));
    },
    [camera.rotation]
  );

  // Re-fit automatically when container resizes or inspector opens/closes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Initial fit on mount
    fitOfficeToViewport();

    // ResizeObserver watches window resize AND flex layout changes when inspector toggles
    const resizeObserver = new ResizeObserver(() => {
      fitOfficeToViewport();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [fitOfficeToViewport, isInspectorOpen]);

  // Center on a specific agent or coordinate
  const focusOnCoordinates = (gx: number, gy: number, zoomLevel = 1.35) => {
    const { x, y } = gridToScreen(gx, gy, camera.rotation);
    setCamera((prev) => ({
      ...prev,
      x: -(x + 24),
      y: -(y + 8),
      zoom: zoomLevel,
    }));
  };

  // If selectedAgentId changes externally, focus on that agent
  useEffect(() => {
    if (selectedAgentId) {
      const agent = visibleAgentsRef.current.find((a) => a.id === selectedAgentId);
      if (agent) {
        focusOnCoordinates(agent.x, agent.y, 1.4);
      }
    }
  }, [selectedAgentId, camera.rotation]);

  // Main Render Loop with requestAnimationFrame
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let previousTime: number | null = null;

    const render = (time: number) => {
      const deltaMs = previousTime === null ? 0 : time - previousTime;
      previousTime = time;
      const visibleAgents = motionRef.current.update(agents, deltaMs, reducedMotion);
      visibleAgentsRef.current = visibleAgents;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const displayWidth = Math.floor(rect.width * dpr);
      const displayHeight = Math.floor(rect.height * dpr);

      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      renderOfficeScene({
        ctx,
        width: rect.width,
        height: rect.height,
        camera,
        agents: visibleAgents,
        selectedAgentId,
        hoveredAgentId,
        activeMeetingId,
        timeMs: reducedMotion ? 1000 : time,
        nowMs: Date.now(),
        reducedMotion,
        theme,
      });

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [camera, agents, selectedAgentId, hoveredAgentId, activeMeetingId, theme, reducedMotion]);

  // Mouse drag & pan
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    dragDistanceRef.current = 0;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (isDraggingRef.current) {
      const deltaScreenX = e.clientX - lastMousePosRef.current.x;
      const deltaScreenY = e.clientY - lastMousePosRef.current.y;
      dragDistanceRef.current += Math.hypot(deltaScreenX, deltaScreenY);
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      setCamera((prev) => ({
        ...prev,
        x: prev.x + deltaScreenX / prev.zoom,
        y: prev.y + deltaScreenY / prev.zoom,
      }));
      return;
    }

    // Hover detection
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const center = cameraCenter(rect.width, rect.height);
    const screenDx = mouseX - center.x;
    const screenDy = mouseY - center.y;
    const worldX = screenDx / camera.zoom - camera.x;
    const worldY = screenDy / camera.zoom - camera.y;

    let foundAgent: Agent | null = null;
    let minDist = 32;

    for (const agent of visibleAgentsRef.current) {
      const { x, y } = gridToScreen(agent.x, agent.y, camera.rotation);
      const dist = Math.hypot(worldX - (x + 24), worldY - (y + 8));
      if (dist < minDist) {
        minDist = dist;
        foundAgent = agent;
      }
    }

    if (foundAgent) {
      setHoveredAgentId(foundAgent.id);
      canvas.style.cursor = 'pointer';
    } else {
      setHoveredAgentId(null);
      canvas.style.cursor = 'grab';
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    if (dragDistanceRef.current > 5) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const center = cameraCenter(rect.width, rect.height);
    const screenDx = mouseX - center.x;
    const screenDy = mouseY - center.y;
    const worldX = screenDx / camera.zoom - camera.x;
    const worldY = screenDy / camera.zoom - camera.y;

    let clickedAgent: Agent | null = null;
    let minDist = 30;

    for (const agent of visibleAgentsRef.current) {
      const { x, y } = gridToScreen(agent.x, agent.y, camera.rotation);
      const dist = Math.hypot(worldX - (x + 24), worldY - (y + 8));
      if (dist < minDist) {
        minDist = dist;
        clickedAgent = agent;
      }
    }

    if (clickedAgent) {
      onSelectAgent(clickedAgent.id);
    }
  };

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
    setCamera((prev) => {
      const newZoom = Math.min(Math.max(prev.zoom * zoomFactor, 0.15), 2.5);
      return { ...prev, zoom: newZoom };
    });
  };

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-slate-950 flex flex-col">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { isDraggingRef.current = false; setHoveredAgentId(null); }}
        onWheel={handleWheel}
        className="w-full h-full block touch-none cursor-grab active:cursor-grabbing"
        role="img"
        aria-label="Oficina animada de agentes. Usa el panel lateral para consultar sus tareas y conversaciones."
      />

      {/* Floating Zoom Control HUD (Bottom Center) */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-slate-900/95 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-slate-800 shadow-2xl z-20 text-xs text-slate-200">
        <button onClick={() => fitOfficeToViewport((camera.rotation + 3) % 4)} aria-label="Girar oficina a la izquierda" title="Girar izquierda" className="p-2 rounded-xl hover:bg-slate-800"><RotateCcw className="w-4 h-4" /></button>
        <button onClick={() => fitOfficeToViewport((camera.rotation + 1) % 4)} aria-label="Girar oficina a la derecha" title="Girar derecha" className="p-2 rounded-xl hover:bg-slate-800"><RotateCw className="w-4 h-4" /></button>
        <button onClick={() => fitOfficeToViewport()} aria-label="Centrar oficina completa" title="Centrar oficina" className="p-2 rounded-xl text-sky-300 hover:bg-slate-800"><Focus className="w-4 h-4" /></button>
        <button
          onClick={() => setCamera((c) => ({ ...c, zoom: Math.max(c.zoom * 0.88, 0.15) }))}
          aria-label="Alejar oficina"
          title="Alejar vista (Zoom Out)"
          className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        <span className="text-[11px] font-mono text-slate-300 w-12 text-center tabular-nums font-semibold">
          {Math.round(camera.zoom * 100)}%
        </span>

        <button
          onClick={() => setCamera((c) => ({ ...c, zoom: Math.min(c.zoom * 1.12, 2.5) }))}
          aria-label="Acercar oficina"
          title="Acercar vista (Zoom In)"
          className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>

      {/* Floating button to re-open sidebar when collapsed */}
      {!isSidebarOpen && onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          className="absolute top-3 right-3 z-20 flex items-center gap-1.5 bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-800 shadow-xl text-xs font-semibold text-slate-200 hover:text-white hover:bg-slate-800 transition-colors"
          title="Mostrar timeline lateral de actividad"
        >
          <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
          <span>Ver Timeline</span>
        </button>
      )}
    </div>
  );
};

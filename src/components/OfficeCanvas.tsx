import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Agent } from '../types/agent';
import { CameraState, renderOfficeScene } from '../engine/canvasRenderer';
import { getOfficeRenderedBounds, gridToScreen, screenToGrid } from '../engine/officeModel';
import { compactTokens } from '../engine/modelOps';
import { OfficeMotion } from '../engine/visualMotion';
import { cameraCenter } from '../engine/visualLayout';
import { Locale, t } from '../i18n';
import {
  ZoomIn,
  ZoomOut,
  Radio,
  Focus,
  RotateCw,
  RotateCcw,
  Server,
} from 'lucide-react';

interface OfficeCanvasProps {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onDoubleClickAgent?: (agentId: string) => void;
  onOpenModelOps?: (providerFilter?: string) => void;
  activeMeetingId: string | null;
  theme: 'dark' | 'light';
  locale: Locale;
  isInspectorOpen?: boolean;
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
}

interface ServerHitInfo {
  type: 'rack' | 'noc' | 'workstation' | 'plaque' | 'room';
  provider?: string;
  name: string;
  detail: string;
}

function checkModelOpsHit(gx: number, gy: number): ServerHitInfo | null {
  if (gx < 17 || gx > 23 || gy < 0 || gy > 5) return null;

  // Server rack 1: OpenAI (gridX: 18, gridY: 1)
  if (gx === 18 && (gy === 1 || gy === 2)) {
    return {
      type: 'rack',
      provider: 'OpenAI',
      name: 'Nodo Servidor OpenAI',
      detail: 'Modelos: gpt-4o, o1-mini · Tokens de prompts y razonamiento',
    };
  }
  // Server rack 2: Anthropic (gridX: 20, gridY: 1)
  if (gx === 20 && (gy === 1 || gy === 2)) {
    return {
      type: 'rack',
      provider: 'Anthropic',
      name: 'Nodo Servidor Anthropic',
      detail: 'Modelos: claude-3-5-sonnet, haiku · Código y UI',
    };
  }
  // Server rack 3: Google Gemini (gridX: 22, gridY: 1)
  if (gx === 22 && (gy === 1 || gy === 2)) {
    return {
      type: 'rack',
      provider: 'Google Gemini',
      name: 'Nodo Servidor Google Gemini',
      detail: 'Modelos: gemini-2.5-pro, flash · 2M ventana de contexto',
    };
  }
  // Server rack 4: Local Ollama (gridX: 22, gridY: 3)
  if (gx === 22 && (gy === 3 || gy === 4)) {
    return {
      type: 'rack',
      provider: 'Local (Ollama)',
      name: 'Rack On-Premise Local',
      detail: 'Modelos: llama-3.3-70b, deepseek · Cómputo local sin coste de nube',
    };
  }
  // NOC Display Screen (gridX: 20..21, gridY: 0)
  if ((gx === 20 || gx === 21) && gy === 0) {
    return {
      type: 'noc',
      name: 'Pantalla Central NOC Model Ops',
      detail: 'Telemetría en vivo del flujo global de tokens',
    };
  }
  // Telemetry Workstation (gridX: 18, gridY: 4)
  if (gx === 18 && (gy === 3 || gy === 4)) {
    return {
      type: 'workstation',
      name: 'Estación de Telemetría Model Ops',
      detail: 'Monitoreo de latencia, caché y throughput',
    };
  }
  // Room Threshold plaque (gy: 5)
  if (gy === 5) {
    return {
      type: 'plaque',
      name: 'Consola Central de Operaciones',
      detail: 'Abrir panel interactivo de consumo de tokens',
    };
  }

  // Any other tile in server_room
  return {
    type: 'room',
    name: 'Sala Model Ops & Token Center',
    detail: 'Monitorización de infraestructura LLM y consumo',
  };
}

export const OfficeCanvas: React.FC<OfficeCanvasProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  onDoubleClickAgent,
  onOpenModelOps,
  activeMeetingId,
  theme,
  locale,
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
  const [hoveredServerItem, setHoveredServerItem] = useState<ServerHitInfo | null>(null);

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
        locale,
      });

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [camera, agents, selectedAgentId, hoveredAgentId, activeMeetingId, theme, locale, reducedMotion]);

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

    const grid = screenToGrid(worldX, worldY, camera.rotation);
    const serverHit = checkModelOpsHit(grid.gx, grid.gy);

    if (foundAgent) {
      setHoveredAgentId(foundAgent.id);
      setHoveredServerItem(null);
      canvas.style.cursor = 'pointer';
    } else if (serverHit) {
      setHoveredAgentId(null);
      setHoveredServerItem(serverHit);
      canvas.style.cursor = 'pointer';
    } else {
      setHoveredAgentId(null);
      setHoveredServerItem(null);
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
      return;
    }

    // Check click on Model Ops server equipment or room
    const grid = screenToGrid(worldX, worldY, camera.rotation);
    const serverHit = checkModelOpsHit(grid.gx, grid.gy);
    if (serverHit) {
      if (serverHit.provider) {
        onOpenModelOps?.(serverHit.provider);
      } else {
        onOpenModelOps?.();
      }
    }
  };

  // Double click handler: opens Agent detail modal or Model Ops console
  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
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
    let minDist = 32;

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
      onDoubleClickAgent?.(clickedAgent.id);
      return;
    }

    const grid = screenToGrid(worldX, worldY, camera.rotation);
    const serverHit = checkModelOpsHit(grid.gx, grid.gy);
    if (serverHit) {
      onOpenModelOps?.(serverHit.provider);
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
        onDoubleClick={handleDoubleClick}
        onMouseLeave={() => {
          isDraggingRef.current = false;
          setHoveredAgentId(null);
          setHoveredServerItem(null);
        }}
        onWheel={handleWheel}
        className="w-full h-full block touch-none cursor-grab active:cursor-grabbing"
        role="img"
        aria-label={t(locale, 'canvas.aria')}
      />

      {/* Floating Tooltip when hovering over Model Ops servers / equipment */}
      {hoveredServerItem && (
        <div
          onClick={() => onOpenModelOps?.(hoveredServerItem.provider)}
          className="absolute top-4 left-4 z-20 flex items-center gap-2.5 bg-slate-900/95 backdrop-blur-md px-3.5 py-2 rounded-xl border border-cyan-500/50 shadow-2xl text-xs text-white cursor-pointer hover:bg-slate-850 hover:border-cyan-400 transition-all animate-in fade-in duration-100"
          title="Haz clic para inspeccionar consumo de tokens"
        >
          <div className="w-8 h-8 rounded-lg bg-cyan-950 border border-cyan-500/50 flex items-center justify-center text-cyan-400 shrink-0">
            <Server className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-white tracking-tight">{hoveredServerItem.name}</span>
              {hoveredServerItem.provider && (
                <span className="text-[10px] font-mono text-cyan-300 bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800/60 font-semibold">
                  {hoveredServerItem.provider}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {hoveredServerItem.detail} · <strong className="text-cyan-300 hover:underline">Abrir Consola Model Ops ⚡</strong>
            </p>
          </div>
        </div>
      )}

      {/* Floating Zoom Control HUD (Bottom Center) */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-slate-900/95 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-slate-800 shadow-2xl z-20 text-xs text-slate-200">
        <button onClick={() => fitOfficeToViewport((camera.rotation + 3) % 4)} aria-label={t(locale, 'canvas.rotateLeft')} title={t(locale, 'canvas.rotateLeft')} className="p-2 rounded-xl hover:bg-slate-800"><RotateCcw className="w-4 h-4" /></button>
        <button onClick={() => fitOfficeToViewport((camera.rotation + 1) % 4)} aria-label={t(locale, 'canvas.rotateRight')} title={t(locale, 'canvas.rotateRight')} className="p-2 rounded-xl hover:bg-slate-800"><RotateCw className="w-4 h-4" /></button>
        <button onClick={() => fitOfficeToViewport()} aria-label={t(locale, 'canvas.fit')} title={t(locale, 'canvas.fit')} className="p-2 rounded-xl text-sky-300 hover:bg-slate-800"><Focus className="w-4 h-4" /></button>
        <button
          onClick={() => setCamera((c) => ({ ...c, zoom: Math.max(c.zoom * 0.88, 0.15) }))}
          aria-label={t(locale, 'canvas.zoomOut')}
          title={t(locale, 'canvas.zoomOut')}
          className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        <span className="text-[11px] font-mono text-slate-300 w-12 text-center tabular-nums font-semibold">
          {Math.round(camera.zoom * 100)}%
        </span>

        <button
          onClick={() => setCamera((c) => ({ ...c, zoom: Math.min(c.zoom * 1.12, 2.5) }))}
          aria-label={t(locale, 'canvas.zoomIn')}
          title={t(locale, 'canvas.zoomIn')}
          className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <ZoomIn className="w-4 h-4" />
        </button>

        {/* Dedicated Quick Action: Model Ops Telemetry Center */}
        <div className="h-4 w-px bg-slate-800 mx-1" />
        <button
          onClick={() => {
            focusOnCoordinates(20, 2, 1.45);
            onOpenModelOps?.();
          }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 border border-cyan-800/60 font-semibold text-[11px] shadow-sm transition-colors"
          title="Ver Sala Model Ops y Consumo de Tokens por Proveedor y Modelo"
        >
          <Server className="w-3.5 h-3.5 text-cyan-400" />
          <span>Model Ops</span>
          <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-cyan-500/20 text-cyan-200">
            Tokens
          </span>
        </button>
      </div>

      {/* Floating button to re-open sidebar when collapsed */}
      {!isSidebarOpen && onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          className="absolute top-3 right-3 z-20 flex items-center gap-1.5 bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-800 shadow-xl text-xs font-semibold text-slate-200 hover:text-white hover:bg-slate-800 transition-colors"
          title={t(locale, 'canvas.showTimeline')}
        >
          <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
          <span>{t(locale, 'canvas.showTimeline')}</span>
        </button>
      )}
    </div>
  );
};

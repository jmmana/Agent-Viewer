import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Agent } from '../types/agent';
import { CameraState, renderOfficeScene, type AgentBadge } from '../engine/canvasRenderer';
import { getOfficeRenderedBounds, gridToScreen, screenToGrid } from '../engine/officeModel';
import { compactTokens } from '../engine/modelOps';
import { OfficeMotion } from '../engine/visualMotion';
import { cameraCenter } from '../engine/visualLayout';
import type { OfficeMessageKey, OfficeTranslate } from '../content/officeMessages';
import {
  ZoomIn,
  ZoomOut,
  Radio,
  Focus,
  Maximize2,
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
  translate: OfficeTranslate;
  /** Draw token and cost telemetry aggregated from the agents. Only the demo app turns it on. */
  usageTelemetry?: boolean;
  /** Pre-formatted per-agent usage badges, keyed by agent id. The canvas never computes these itself. */
  agentBadges?: ReadonlyMap<string, AgentBadge>;
  /**
   * Declare the theme tokens on the canvas root. Turn it off when a parent (such as `.av-office`) already
   * declares them, so host overrides on that parent reach the toolbar too.
   */
  themeScope?: boolean;
  isInspectorOpen?: boolean;
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
  /** Memoria del contenedor para conservar la cámara al desmontar el viewport. */
  cameraMemory?: React.MutableRefObject<CameraState | null>;
}

interface ServerHitInfo {
  type: 'rack' | 'noc' | 'workstation' | 'plaque' | 'room';
  provider?: string;
  name: OfficeMessageKey;
  detail: OfficeMessageKey;
}

function checkModelOpsHit(gx: number, gy: number): ServerHitInfo | null {
  if (gx < 17 || gx > 23 || gy < 0 || gy > 5) return null;

  // Server racks (gridY 1..2 on gx 18, 20, 22) and the local rack (gx 22, gy 3..4)
  if (gx === 18 && (gy === 1 || gy === 2)) {
    return { type: 'rack', provider: 'OpenAI', name: 'modelOps.rack.openai', detail: 'modelOps.rack.openaiDetail' };
  }
  if (gx === 20 && (gy === 1 || gy === 2)) {
    return { type: 'rack', provider: 'Anthropic', name: 'modelOps.rack.anthropic', detail: 'modelOps.rack.anthropicDetail' };
  }
  if (gx === 22 && (gy === 1 || gy === 2)) {
    return { type: 'rack', provider: 'Google Gemini', name: 'modelOps.rack.gemini', detail: 'modelOps.rack.geminiDetail' };
  }
  if (gx === 22 && (gy === 3 || gy === 4)) {
    return { type: 'rack', provider: 'Local (Ollama)', name: 'modelOps.rack.local', detail: 'modelOps.rack.localDetail' };
  }
  // NOC Display Screen (gridX: 20..21, gridY: 0)
  if ((gx === 20 || gx === 21) && gy === 0) {
    return { type: 'noc', name: 'modelOps.noc', detail: 'modelOps.nocDetail' };
  }
  // Telemetry Workstation (gridX: 18, gridY: 4)
  if (gx === 18 && (gy === 3 || gy === 4)) {
    return { type: 'workstation', name: 'modelOps.workstation', detail: 'modelOps.workstationDetail' };
  }
  // Room Threshold plaque (gy: 5)
  if (gy === 5) {
    return { type: 'plaque', name: 'modelOps.plaque', detail: 'modelOps.plaqueDetail' };
  }

  // Any other tile in server_room
  return { type: 'room', name: 'modelOps.room', detail: 'modelOps.roomDetail' };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const OfficeCanvas: React.FC<OfficeCanvasProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  onDoubleClickAgent,
  onOpenModelOps,
  activeMeetingId,
  theme,
  translate,
  usageTelemetry = false,
  agentBadges,
  themeScope = true,
  isInspectorOpen = false,
  onToggleSidebar,
  isSidebarOpen = false,
  cameraMemory,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionRef = useRef(new OfficeMotion());
  const visibleAgentsRef = useRef<Agent[]>(agents);
  const dragDistanceRef = useRef(0);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [hoveredServerItem, setHoveredServerItem] = useState<ServerHitInfo | null>(null);
  const modelOpsEnabled = Boolean(onOpenModelOps);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  // Camera State with 4-way rotation
  const restoreOnMount = useRef(cameraMemory?.current != null);
  const previousViewport = useRef<{width:number;height:number} | null>(null);
  const [camera, setCamera] = useState<CameraState>(() => cameraMemory?.current ?? ({
    x: 0,
    y: 0,
    zoom: 1.1,
    rotation: 0, // 0: SE, 1: SW, 2: NW, 3: NE
  }));
  const previousFocus = useRef(restoreOnMount.current ? {id:selectedAgentId, rotation:camera.rotation} : null);
  useEffect(() => { if (cameraMemory) cameraMemory.current = camera; }, [camera,cameraMemory]);

  const isDraggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);

  /**
   * Fit-to-View: Dynamically calculates the rendered world bounding box of all
   * office elements and scales/centers the office to occupy the complete available canvas space,
   * extending cleanly under the floating bottom menu bar without unnecessary margins.
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

      // Usable area: use full canvas dimensions with clean edge padding
      const topPadding = 6;
      const bottomPadding = 6;
      const horizontalPadding = 8;

      const usableWidth = Math.max(availableWidth - horizontalPadding * 2, 100);
      const usableHeight = Math.max(availableHeight - topPadding - bottomPadding, 100);

      // Office occupies 99% of usable canvas area to maximize viewport usage
      const targetCoverage = 0.99;

      const scaleX = (usableWidth * targetCoverage) / bounds.width;
      const scaleY = (usableHeight * targetCoverage) / bounds.height;

      // Uniform scale preserving 2.5D geometric proportions
      const targetZoom = Math.min(scaleX, scaleY);
      const clampedZoom = Math.min(Math.max(targetZoom, 0.15), 2.5);

      // Center exactly on the bounding box center point.
      // Compensate for the 24px vertical shift in cameraCenter (height / 2 - 24)
      // so the office sits centered in the viewport and extends cleanly to the bottom edge.
      const verticalOffset = 24 / clampedZoom;

      setCamera((prev) => ({
        ...prev,
        x: -bounds.centerX,
        y: -bounds.centerY + verticalOffset,
        zoom: clampedZoom,
        rotation: currentRot,
      }));
    },
    [camera.rotation]
  );

  // Al restaurar, el primer layout no debe borrar el encuadre guardado.
  const fitWhenLayoutChanges = useCallback(() => {
    if (!cameraMemory) { fitOfficeToViewport(); return; }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const previous = previousViewport.current;
    if (previous?.width === rect.width && previous.height === rect.height) return;
    previousViewport.current = {width:rect.width,height:rect.height};
    if (!previous && restoreOnMount.current) return;
    fitOfficeToViewport();
  }, [cameraMemory,fitOfficeToViewport]);

  // Re-fit automatically when container resizes or sidebar/inspector toggles
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Initial fit on mount
    fitWhenLayoutChanges();
    if (typeof ResizeObserver === 'undefined') return;

    // ResizeObserver watches window resize AND flex layout changes when sidebar toggles
    const resizeObserver = new ResizeObserver(() => {
      fitWhenLayoutChanges();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [fitWhenLayoutChanges, isInspectorOpen, isSidebarOpen]);

  // Smooth re-fit after sidebar expand/collapse transition finishes
  useEffect(() => {
    const timer = setTimeout(() => {
      fitWhenLayoutChanges();
    }, 120);
    return () => clearTimeout(timer);
  }, [isSidebarOpen, fitWhenLayoutChanges]);

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
    if (cameraMemory && previousFocus.current?.id === selectedAgentId && previousFocus.current.rotation === camera.rotation) return;
    previousFocus.current = {id:selectedAgentId,rotation:camera.rotation};
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
        translate,
        usageTelemetry,
        agentBadges,
      });

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [camera, agents, selectedAgentId, hoveredAgentId, activeMeetingId, theme, translate, usageTelemetry, agentBadges, reducedMotion]);

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
    const serverHit = modelOpsEnabled ? checkModelOpsHit(grid.gx, grid.gy) : null;

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
    if (!modelOpsEnabled) return;
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

    if (!modelOpsEnabled) return;
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

  const zoomLabel = translate('canvas.zoomLevel', { percent: Math.round(camera.zoom * 100) });

  return (
    <div className={themeScope ? `av-canvas-root av-theme-${theme}` : 'av-canvas-root'}>
      <div className="av-toolbar" role="toolbar" aria-label={translate('canvas.toolbar')}>
        <button
          type="button"
          className="av-tool-btn"
          onClick={() => fitOfficeToViewport((camera.rotation + 3) % 4)}
          aria-label={translate('canvas.rotateLeft')}
          title={translate('canvas.rotateLeft')}
        >
          <RotateCcw className="av-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="av-tool-btn"
          onClick={() => fitOfficeToViewport((camera.rotation + 1) % 4)}
          aria-label={translate('canvas.rotateRight')}
          title={translate('canvas.rotateRight')}
        >
          <RotateCw className="av-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="av-tool-btn av-tool-btn--accent"
          onClick={() => fitOfficeToViewport()}
          aria-label={translate('canvas.fit')}
          title={translate('canvas.fit')}
        >
          <Maximize2 className="av-icon" aria-hidden="true" />
        </button>

        <div className="av-toolbar-sep" aria-hidden="true" />

        <button
          type="button"
          className="av-tool-btn"
          onClick={() => setCamera((c) => ({ ...c, zoom: Math.min(c.zoom * 1.12, 2.5) }))}
          aria-label={translate('canvas.zoomIn')}
          title={translate('canvas.zoomIn')}
        >
          <ZoomIn className="av-icon" aria-hidden="true" />
        </button>
        <span className="av-zoom-level" aria-label={zoomLabel} title={zoomLabel}>
          {Math.round(camera.zoom * 100)}%
        </span>
        <button
          type="button"
          className="av-tool-btn"
          onClick={() => setCamera((c) => ({ ...c, zoom: Math.max(c.zoom * 0.88, 0.15) }))}
          aria-label={translate('canvas.zoomOut')}
          title={translate('canvas.zoomOut')}
        >
          <ZoomOut className="av-icon" aria-hidden="true" />
        </button>

        {(modelOpsEnabled || onToggleSidebar) && <div className="av-toolbar-sep" aria-hidden="true" />}

        {modelOpsEnabled && (
          <button
            type="button"
            className="av-tool-btn av-tool-btn--telemetry"
            onClick={() => {
              focusOnCoordinates(20, 2, 1.45);
              onOpenModelOps?.();
            }}
            aria-label={translate('canvas.modelOps')}
            title={translate('canvas.modelOps')}
          >
            <Server className="av-icon" aria-hidden="true" />
          </button>
        )}

        {onToggleSidebar && (
          <button
            type="button"
            className={`av-tool-btn${isSidebarOpen ? ' av-tool-btn--active' : ''}`}
            onClick={onToggleSidebar}
            aria-pressed={isSidebarOpen}
            aria-label={translate(isSidebarOpen ? 'canvas.hideTimeline' : 'canvas.showTimeline')}
            title={translate(isSidebarOpen ? 'canvas.hideTimeline' : 'canvas.showTimeline')}
          >
            <Radio className={`av-icon${isSidebarOpen ? '' : ' av-icon--live'}`} aria-hidden="true" />
          </button>
        )}
      </div>

      <div ref={containerRef} className="av-stage">
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
          className="av-canvas"
          role="img"
          aria-label={translate('canvas.aria')}
        />

        {hoveredServerItem && (
          <button
            type="button"
            className="av-tooltip"
            onClick={() => onOpenModelOps?.(hoveredServerItem.provider)}
            title={translate('modelOps.hint')}
          >
            <span className="av-tooltip-icon" aria-hidden="true">
              <Server className="av-icon" />
            </span>
            <span className="av-tooltip-body">
              <span className="av-tooltip-title">
                {translate(hoveredServerItem.name)}
                {hoveredServerItem.provider && <span className="av-tooltip-tag">{hoveredServerItem.provider}</span>}
              </span>
              <span className="av-tooltip-detail">
                {translate(hoveredServerItem.detail)} · <strong>{translate('modelOps.open')}</strong>
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
};

import type { CrewCallPhase } from './crewCallTimeline';

/**
 * Capa de superposición de llamada (issue #145): dibuja el aviso visual (anillo + icono
 * de teléfono) sobre un actor cuyo `agent.status` real es `PHONE_CALL`. Es un efecto
 * visual, nunca una prueba de conectividad real: no valida red, latencia ni acceso real
 * a un proveedor de telefonía. Recibe el punto ya proyectado por la cámara (igual que
 * `crewHudLayer`), así que zoom/pan/las cuatro orientaciones siguen funcionando sin
 * ningún cálculo adicional aquí.
 *
 * Si el icono real del banco (`effects/call.svg`, vía `useCrewCallIcon`) no cargó, dibuja
 * un glifo de respaldo con la misma paleta para que el aviso nunca desaparezca por un
 * fallo de red del propio icono.
 */
export interface CrewCallOverlayStyle {
  phase: CrewCallPhase;
  /** 0..1: fase del pulso de anillo. Debe ser 0 cuando `reducedMotion` o la fase no es `ringing`. */
  pulseT: number;
  /** 0..1: opacidad del aviso completo; baja a 0 durante el desvanecido final (`ending`). */
  opacity: number;
  icon?: HTMLImageElement;
}

const CALL_ICON_SIZE = 18;
const CALL_RING_COLOR = '#2563eb';

/** Reloj de pulso puro del anillo de llamada: 0..1 en un ciclo de `periodMs`. Sin `Date.now()` ni rAF. */
export function crewCallPulseValue(elapsedMs: number, periodMs = 900): number {
  if (periodMs <= 0) return 0;
  const clamped = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  return (clamped % periodMs) / periodMs;
}

export function drawCrewCallOverlay(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  spriteDrawn: boolean,
  style: CrewCallOverlayStyle,
): void {
  if (style.opacity <= 0) return;
  const anchorY = point.y - (spriteDrawn ? 86 : 34);
  ctx.save();
  ctx.globalAlpha = style.opacity;
  if (style.phase === 'ringing') {
    for (const offset of [0, 0.5]) {
      const t = (style.pulseT + offset) % 1;
      ctx.beginPath();
      ctx.arc(point.x, anchorY, 10 + t * 14, 0, Math.PI * 2);
      ctx.strokeStyle = CALL_RING_COLOR;
      ctx.lineWidth = 2;
      ctx.globalAlpha = style.opacity * (1 - t);
      ctx.stroke();
    }
    ctx.globalAlpha = style.opacity;
  } else {
    ctx.beginPath();
    ctx.arc(point.x, anchorY, 12, 0, Math.PI * 2);
    ctx.strokeStyle = CALL_RING_COLOR;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (style.icon) {
    ctx.drawImage(style.icon, point.x - CALL_ICON_SIZE / 2, anchorY - CALL_ICON_SIZE / 2, CALL_ICON_SIZE, CALL_ICON_SIZE);
  } else {
    // Glifo de respaldo: misma paleta que effects/call.svg (fondo claro, trazo y auricular azules).
    ctx.beginPath();
    ctx.arc(point.x, anchorY, CALL_ICON_SIZE / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = CALL_RING_COLOR;
    ctx.beginPath();
    ctx.ellipse(point.x, anchorY, 5, 3, Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

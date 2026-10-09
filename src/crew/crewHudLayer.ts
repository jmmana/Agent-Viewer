import type { CrewPresenceMarker } from './crewPresence';
import { crewPresenceBadgeColor } from './crewLightingLayer';

/**
 * Capa de HUD: la insignia numerada de presencia es el único elemento de interfaz
 * dibujado sobre el canvas Crew (los controles reales son HTML en `CrewStage`). No
 * conoce sprites ni props; recibe el punto ya proyectado y si hubo sprite dibujado,
 * para decidir el desplazamiento vertical de la insignia.
 */
export function drawCrewPresenceBadge(ctx: CanvasRenderingContext2D, point: { x: number; y: number },
  marker: Pick<CrewPresenceMarker, 'status' | 'number'>, spriteDrawn: boolean): void {
  const badgeY = point.y + (spriteDrawn ? 9 : 0);
  ctx.beginPath();
  ctx.ellipse(point.x, badgeY, 12, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = crewPresenceBadgeColor(marker.status);
  ctx.fill();
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(marker.number), point.x, badgeY);
}

/**
 * Primitivas de dibujo genéricas del renderer Crew, sin conocimiento de sala, sprite
 * ni HUD. Escena, props y otras capas comparten estas funciones para no duplicar el
 * trazado de un polígono relleno, que es la única forma que dibuja el renderer 2.5D.
 */
export interface CrewPoint { x: number; y: number }

/** Relleno y trazo de un polígono cerrado en las coordenadas ya proyectadas. */
export function crewPolygon(ctx: CanvasRenderingContext2D, points: readonly CrewPoint[], fill: string, stroke = '#334155'): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

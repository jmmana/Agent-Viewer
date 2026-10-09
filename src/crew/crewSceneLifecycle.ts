/**
 * Ciclo de vida de una escena Crew, independiente de React: programa un cuadro de
 * render por `requestAnimationFrame`, observa el tamaño del canvas con
 * `ResizeObserver` y limpia ambos recursos al desmontar. Permite probar montar,
 * actualizar y desmontar una escena como una unidad, sin un renderer de React ni un
 * navegador real (ver `tests/lib/crewSceneLifecycle.test.ts`, incluida una prueba de
 * extremo a extremo con `renderCrewRoom`).
 *
 * `CrewStage` sigue administrando su propio efecto de render/resize en línea: queda
 * pendiente, en un cambio aparte, migrarlo a este módulo sin arrastrar ese riesgo al
 * alcance de este issue.
 *
 * No dibuja nada por sí mismo: `render` es la función de dibujo que el llamador ya
 * armó (por ejemplo, a partir de `renderCrewRoom`). Este módulo solo programa cuándo
 * se ejecuta y garantiza que deja de ejecutarse tras `unmount`.
 */
export interface CrewSceneHandle {
  /** Reemplaza la función de render activa y programa un nuevo cuadro con ella. */
  update: (render: () => void) => void;
  /** Cancela el cuadro pendiente y desconecta el observador de tamaño. Idempotente. */
  unmount: () => void;
}

/** Monta la escena sobre un canvas ya presente en el DOM y dibuja el primer cuadro. */
export function mountCrewScene(canvas: HTMLCanvasElement, render: () => void, onResize?: () => void): CrewSceneHandle {
  let current = render;
  let frame = requestAnimationFrame(() => current());
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    onResize?.();
    current();
  }) : null;
  observer?.observe(canvas);
  return {
    update(next) {
      current = next;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => current());
    },
    unmount() {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

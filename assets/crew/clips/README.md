# Clips originales de Crew

## CEO: caminar en cuatro direcciones

Catálogo canónico: `manifest.v1.json`, cuatro atlas `ceo-walk-{front,right,back}-v1.png` y `ceo-walk-left-v2.png`. Cada uno contiene ocho dibujos originales. Generados con image_gen integrado, sin retocar ni reescalar PNG; originales del banco preservados. Estado prototype, nunca aprobado automáticamente. Prompts exactos y estudio izquierdo descartado: `../origins/walk-117/`. Procedencia, hashes y recortes reales figuran en el catálogo. Ver [contrato e importador](../../../docs/crew/FRAME-PIPELINE.es.md) y [evidencia runtime](../../../docs/crew/evidence/walk-117/).

## CEO: parpadeo frontal v1

Atlas: `ceo-blink-front-v1.png`, 1070 × 1470, RGBA. Cuatro celdas de 535 × 735 en orden de lectura. Generado con la herramienta integrada image_gen el 2026-10-09, a partir de `../bank/characters/ceo/idle-front.png`, sin modificar ni sustituir el original. Hashes y procedencia: `ceo-blink-front-v1.json`. Estado: prototype, no aprobado como arte final.

El contrato runtime está en `src/crew/crewAnimation.ts`. Duraciones: 3200, 80, 100 y 80 ms. El anclaje de cada fotograma se midió sobre los pies opacos del atlas para compensar diferencias de ubicación sin modificar los píxeles. La altura de presentación permanece en 76 unidades. Los ojos cambian de expresión; no se desplaza una pose estática para simular el parpadeo.

Es un gesto cosmético frontal, sin eventos de trabajo ni locomoción. Las otras vistas mantienen su pose original. Movimiento reducido desactiva la descarga del atlas y conserva el PNG estático; la pestaña oculta pausa el reloj y vuelve al cuadro abierto al regresar. Fallos del atlas conservan la pose original. Se cancela la carga y los temporizadores al cambiar sala/vista o salir de Crew.

El archivo generado original permanece también en la carpeta de generación de Codex. Solo se copió el PNG al proyecto; no se retocó ni se reescaló.

## Prompt utilizado (herramienta integrada)

```text
Use case: identity-preserve. Asset type: production game sprite animation atlas for Agent Viewer Crew. Input image is the exact CEO identity and full-body pose reference. Generate a transparent PNG sprite sheet with exactly FOUR equal-sized cells in a 2 by 2 grid. Each cell contains the SAME identical full-body front-facing CEO at EXACTLY the same scale, centered position, foot baseline, hair shape, clothes, glasses, badge and resting arm/leg pose. Only eyelids change. Read order row-major: 1 eyes open, 2 eyes half closed, 3 eyes fully closed in natural blink, 4 eyes half opening. Keep entire body visible in each cell with clear transparent padding, identical foot anchor relative to each cell at x=0.5 y=0.9375. Keep the reference's navy suit, blue tie, dark brown hair, black glasses, golden badge, soft polished chibi illustration rendering. No movement of head, hands, torso or feet between cells. No text, numbers, borders, background, ground shadows or additional props. Exact regular grid is essential for canvas source-rectangle playback, not a collage. Preserve identity as closely as possible. Output one atlas, ideally 1024x1408 pixels with four 512x704 cells, genuinely transparent.
```

La salida no respetó las dimensiones ideales ni un anclaje uniforme solicitado. Se registraron sus dimensiones reales y anclajes por fotograma en el contrato, en lugar de asumir el tamaño del prompt. La revisión visual de las expresiones y el piloto no certifica caminar, teclear, llamar ni los criterios completos de #117/#118.

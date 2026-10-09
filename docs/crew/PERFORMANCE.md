# Rendimiento y memoria del renderer Crew (issue #158)

Este documento describe las herramientas de medicion de rendimiento del
renderer Crew existente (`src/crew/`) y los umbrales propuestos para
aceptarlo. No crea arte ni escenas nuevas: mide lo que ya existe.

## Punto de partida verificado

Antes de escribir estas herramientas se releyo el issue #158 completo y el
renderer actual en `src/crew/`:

- El catalogo tiene **once salas** (`CREW_ROOMS` en `src/crew/crewModel.ts`):
  `ceo`, `development`, `planning`, `research`, `qa`, `finance`, `meeting`,
  `infrastructure`, `coffee`, `lounge`, `reception`.
- `CrewStage` (`src/crew/CrewStage.tsx`) **no corre un bucle continuo de
  `requestAnimationFrame`**. Pinta una vez al montar y una vez por cada
  cambio de estado relevante (sala, camara, sprites cargados, parpadeo). El
  parpadeo del CEO usa `setTimeout` encadenado (`useCrewBlink`), no RAF.
  Esto es, en si mismo, una buena caracteristica de rendimiento (CPU
  practicamente en cero en reposo), pero significa que "FPS sostenidos" solo
  tiene sentido mientras hay interaccion continua (pan/zoom) o un parpadeo
  activo.
- Solo el rol `boss` (CEO) tiene sprites ilustrados reales
  (`src/crew/sprites/ceo-*.ts`); el resto de roles se dibuja como marcador
  circular con numero. El costo de dibujar un agente adicional es, hoy,
  mayormente geometria (proyeccion isometrica + orden por profundidad), no
  decodificacion de imagenes.
- `tests/e2e/crew-domain.spec.ts` ya verificaba, de forma incidental (para el
  issue #159), que solo existe **un** `<canvas>` a la vez. No existia, antes
  de este cambio, ninguna medicion formal de FPS, memoria o fugas al cambiar
  de sala repetidamente. Esa es la carencia que cubre este issue.
- El issue #158 no fija numeros concretos de presupuesto mas alla de "60 FPS
  objetivo / 30 FPS piso" y los niveles de agentes "0/6/20/50". Los umbrales
  de abajo son una propuesta explicita de este cambio, no un acuerdo previo
  del equipo.

## Herramientas

### 1. `npm run crew:perf:bench` (costo JS puro, determinista, apto para CI)

`scripts/crew-perf-benchmark.mjs` llama a `renderCrewRoom` (la funcion pura de
dibujo, sin React ni canvas real) con un contexto 2D "no-op" para cada una de
las once salas y cuatro niveles de agentes (0/6/20/50), y mide el tiempo de
CPU en JavaScript (mediana, p95, maximo de 200 muestras tras 20 de
calentamiento). Esto aisla el costo que el renderer controla (proyeccion,
orden por profundidad, recorrido de mobiliario/marcadores) del costo de
rasterizado y composicion real del navegador, que esta herramienta no mide.

Presupuesto propuesto: **8ms** (un cuarto del piso de 30 FPS = 33.3ms),
dejando el resto del cuadro para el navegador. Escribe
`docs/crew/perf/latest.json` y termina con codigo de salida distinto de cero
si alguna combinacion sala x agentes lo supera.

Ultima corrida local (Node, ver `docs/crew/perf/latest.json`): las 44
combinaciones (11 salas x 4 niveles) quedaron entre 0.004ms y 0.42ms de
mediana/maximo, muy por debajo del presupuesto. Con 50 agentes el costo
mediano ronda 0.02-0.03ms en todas las salas.

### 2. `npx vitest run tests/lib/crewPerfBudget.test.ts` (compuerta de CI)

Version mas pequena del benchmark anterior, integrada en `npm test` (parte de
`npm run test:unit`), que falla si el costo mediano de dibujar una sala con
50 agentes supera el presupuesto de 8ms, o si el costo entre 0 y 50 agentes
crece de forma no lineal (guarda contra un costo cuadratico accidental). Es
la compuerta automatica de regresion de este issue.

### 3. `npx vitest run tests/lib/crewMountLeak.test.tsx` (fugas, determinista)

Monta y desmonta `CrewStage` **100 veces**, recorriendo las once salas del
catalogo, con temporizadores falsos (`vi.useFakeTimers`) y espias sobre
`window`/`document.addEventListener`. Verifica, en cada uno de los 100
ciclos, que:

- Queda pendiente como maximo un `requestAnimationFrame` (el del primer
  pintado de esa instancia) y que se cancela al desmontar: nunca se acumulan
  cuadros programados de salas que ya no existen.
- Nunca hay mas de un `<canvas>` en el documento a la vez.
- Al terminar los 100 ciclos, el total de altas y bajas de listeners de
  `window` y `document` coincide (ninguno queda huerfano). El listener global
  de `selectionchange` que React adjunta una sola vez por documento (no por
  componente, no por issue) se excluye explicitamente del conteo con un
  comentario en el test: no pertenece al ciclo de vida de `CrewStage`.

Esta es la forma determinista y reproducible en CI de "medir leaks al
cambiar 100 veces de sala", sin depender de la sensibilidad del recolector de
basura de un navegador real.

### 4. `npm run crew:perf:browser` (FPS pintados y heap en Chromium real, informativo)

`scripts/crew-perf-browser.mjs` requiere `npm run dev` corriendo en
`http://127.0.0.1:3000` (o `CREW_CAPTURE_URL`) y Chromium instalado para
Playwright (`PLAYWRIGHT_CHANNEL=chrome` si usas el canal del sistema, igual
que `crew:capture`). Para cada sala:

- Cuenta cuadros realmente pintados (llamadas a `canvas.getContext('2d')`,
  que es exactamente una vez por cada `render()` de `CrewStage`) mientras
  dispara eventos de rueda sinteticos durante 2 segundos, simulando
  interaccion continua de zoom.
- Cambia de sala 100 veces y mide `performance.memory.usedJSHeapSize` cada 10
  ciclos, forzando recoleccion de basura via CDP (`HeapProfiler.collectGarbage`)
  antes de cada muestra.

Esto **no es una compuerta de CI**: `performance.memory` es una aproximacion
no estandar de Chromium y el numero de cuadros pintados en un Chromium
headless sin vsync real depende de la maquina. Se documenta como evidencia
manual, reproducible a mano, y se vuelve a correr antes de cada PR que toque
el renderer.

Ultima corrida local (`docs/crew/perf/browser-latest.json`, Chromium
headless, macOS, sin dispositivo fisico ni movil):

| Sala | Cuadros pintados / 2s | FPS pintados |
| --- | --- | --- |
| ceo | 238 | 118.3 |
| development | 238 | 118.9 |
| planning | 238 | 118.5 |
| research | 238 | 118.8 |
| qa | 238 | 118.7 |
| finance | 238 | 118.3 |
| meeting | 238 | 118.6 |
| infrastructure | 238 | 118.5 |
| coffee | 238 | 118.6 |
| lounge | 238 | 118.3 |
| reception | 236 | 117.1 |

Heap: 36.12MB en el ciclo 0, 36.56MB tras 100 cambios de sala (**+0.42MB**,
~4.2KB por ciclo), sin tendencia de crecimiento acelerado entre muestras.
Un solo `<canvas>` visible al terminar los 100 ciclos.

Nota: la cifra de ~118 FPS refleja el limite del bucle `requestAnimationFrame`
que dispara los eventos de prueba en un Chromium headless sin limite real de
V-Sync, no un techo del renderer. Lo relevante para el issue es que no cae
por debajo del piso de 30 FPS en ninguna sala con la interaccion simulada, y
que el heap no crece de forma sostenida al cambiar de sala.

## Umbrales propuestos (para acordar, no un hecho previo del equipo)

| Metrica | Objetivo | Piso | Donde se mide |
| --- | --- | --- | --- |
| Costo JS por cuadro (`renderCrewRoom`, 50 agentes) | <= 4ms | <= 8ms | `crew:perf:bench`, `crewPerfBudget.test.ts` |
| Cuadros pintados sostenidos durante interaccion | 60 FPS | 30 FPS | `crew:perf:browser` (informativo) |
| `<canvas>` simultaneos | 1 | 1 | `crewMountLeak.test.tsx`, `crew-domain.spec.ts` |
| `requestAnimationFrame` pendientes tras desmontar | 0 | 0 | `crewMountLeak.test.tsx` |
| Listeners `window`/`document` huerfanos tras 100 ciclos | 0 | 0 | `crewMountLeak.test.tsx` |
| Crecimiento de heap tras 100 cambios de sala | Sin tendencia sostenida | N/D (criterio cualitativo) | `crew:perf:browser` (informativo) |

## Que queda fuera de este issue

- Medicion en dispositivo movil fisico o en un navegador real no headless
  (el issue lo pide; requiere laboratorio de dispositivos que no esta
  disponible en este entorno. `crew:perf:browser` corre igual en un Chromium
  de escritorio emulado a resolucion movil, pero eso no sustituye hardware
  real).
- Compresion GPU/Canvas, LRU de assets entre salas, culling de particulas:
  hoy no existen en el renderer (solo hay un sprite ilustrado, el del CEO), y
  crearlos es trabajo de arte/renderer de otros issues (#167, #169, #117,
  #130), no de este issue de medicion.
- Certificacion G1 de Crew: sigue pendiente arte final, animaciones de
  trabajo y los 50 agentes globales reales del issue (aqui se estresa con
  marcadores sinteticos, no con el flujo completo del dominio).

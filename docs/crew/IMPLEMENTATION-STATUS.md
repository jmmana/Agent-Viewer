# Estado de implementación de Crew

Actualizado: 2026-10-10 (America/Bogota). Main observado: `7173be9`.
Último avance: #117, 32 cuadros CEO y pipeline en revisión. Avance anterior: #155, puente de eventos de solo lectura hacia tarea/reunión/aprobación e insignia explícita LIVE/DEMO/REPLAY (sin cerrar). Avance previo sin cerrar en #167, módulos independientes del renderer Crew, #158, benchmarks de rendimiento, y #157, controles de accesibilidad. Último issue completado: #116, contrato de estilo visual Crew. Avance sin cerrar también en #170, colisiones AABB, puertas funcionales y zonas navegables sobre las once salas. Último issue cerrado: #166, contrato de arquitectura de dos modos. Epic: #114.

## Avances y cierres verificados

| Issue | Resultado | PR integrado y verificación |
| --- | --- | --- |
| [#117](https://github.com/jmmana/Agent-Viewer/issues/117) | Pipeline independiente implementado: cuatro atlas originales de caminar, ocho fases por orientación, manifiesto versionado con procedencia, anclajes y duración, importador solo prototype y carga/cancelación/fallback en el Crew real. El piloto permanece prototype por diferencias de proporción y residuos alfa. La reproducción usa isWalking reportado en el punto del snapshot; trayectorias físicas de #129 y acciones completas/arte final de #118 siguen pendientes. No certifica G1. | Rama `feat/crew-117-walk-atlases`, PR y CI finales pendientes de esta revisión. Ver [FRAME-PIPELINE.md](FRAME-PIPELINE.md), [PNG de cuatro orientaciones/móvil/zoom](evidence/walk-117/) y [MP4 runtime](evidence/walk-117/runtime.mp4). Pruebas focales: 21 Node de integridad/importación, 7 Vitest de reproducción/pureza y 5 E2E Chrome aislado. Cierre condicionado a la batería final y revisión del PR. |
| [#155](https://github.com/jmmana/Agent-Viewer/issues/155) | No se cierra (Refs, no Closes). Se revisó primero el intento previo [PR #190](https://github.com/jmmana/Agent-Viewer/pull/190): quedó CLOSED pero sin descartarse, porque sus commits (`feat/crew-presence-focus-155`, marcadores de presencia y foco) ya habían entrado a main mediante el merge consolidado de [PR #194](https://github.com/jmmana/Agent-Viewer/pull/194); no hubo nada que rescatar aparte porque ya estaba integrado. Esta entrega retoma la recomendación explícita de "Próximos tres pasos" (sección inferior): ampliar el bridge de tareas y reuniones sobre la presencia ya existente. Se agregó `src/crew/crewEventBridge.ts`, un adaptador de solo lectura que proyecta `agent.currentTaskId`/`agent.currentTool`/`agent.status` y las listas de tareas/reuniones del snapshot (nuevo campo `tasks` en `OfficeSnapshot`, aditivo, Caricatura no lo consume) hacia una actividad por agente: tarea y su estado real, participación en reunión ACTIVA, aprobación pendiente y uso de herramienta en curso. Se agregó también una insignia explícita LIVE/DEMO/REPLAY (`crewViewerMode` en `CrewStage`/`AgentOffice`, reutilizando el tipo `ViewerMode` ya existente en `integrations/replayEngine.ts`) que el host decide, nunca inferida de los datos, y un modo `crewVisibility: 'minimized'` que oculta el título de tarea y el tema de reunión en pantallas públicas o televisores, conservando solo la categoría. No se cierra el issue: quedan pendientes animación real de reuniones/traslados, redacción de `statusText`/`speechBubble` en modo minimizado, y la certificación G1; el dedupe por ID, los buffers y la reconexión SSE ya los resuelve `OfficeStore`/`applyExternalEvent` compartido con Caricatura (#54/#72), así que Crew no reimplementa esa infraestructura. | [PR #242](https://github.com/jmmana/Agent-Viewer/pull/242), rama `feat/crew-155-event-bridge` sobre main `7173be9`. 727 Vitest (16 nuevos en `crewEventBridge.test.ts`) y 1031 node:test (1 omitida, preexistente), typecheck, 24 E2E Chrome (2 nuevos verifican la insignia LIVE/REPLAY/DEMO en runtime real), builds app/lib/CLI, `check:package`, SDK Python (29/29) y `npm audit --omit=dev` sin vulnerabilidades, todos aprobados localmente. Contrato documentado en [EMBEDDED-API.md](EMBEDDED-API.md). |
| [#116](https://github.com/jmmana/Agent-Viewer/issues/116) | No se cierra. Entrega únicamente documental: contrato de estilo visual Crew (inglés y gemelo español), formaliza el ciclo de vida `reference/vector-study/prototype/approved`, el lienzo de personaje 256x352 con anclaje 0.5/0.9375 ya vigente en los 11 prototipos, las fichas de silueta/paleta de los seis roles (paleta del CEO redactada en la referencia aprobada, las otras cinco medidas automáticamente del arte prototipo y marcadas sin ratificar), el contrato de clips/animación y las remisiones al ADR-001, ADR-002 y FACING.md. No se creó arte nuevo ni se promovió ningún asset a `approved`. El issue queda abierto porque sus criterios de aceptación y "Pruebas y evidencia" piden el sistema visual/animado completo (render en 4 cámaras por sala, clips de caminar de 6+ cuadros por rol, cobertura DEMO/LIVE/REPLAY y E2E móvil/teclado/i18n), pendiente de CREW-001..008. | [PR #230](https://github.com/jmmana/Agent-Viewer/pull/230), rama `feat/crew-116-style-guide`, fusionado. CI (`verify`, `cli-node-22`, `crew-browser`) aprobado en ambos runs. `validateCrewAssets()` ahora exige también el lienzo/anclaje de personaje documentado para las 11 entradas `character`, con dos casos nuevos en `tests/crew-assets.test.mjs` y una aserción dedicada sobre los 11 prototipos. Ver [docs/crew/visual-style-contract.md](visual-style-contract.md) y su gemelo [.es.md](visual-style-contract.es.md). |
| [#170](https://github.com/jmmana/Agent-Viewer/issues/170) | No se cierra. El issue sigue abierto como documento de alcance amplio (cuatro cámaras coherentes, evidencia gráfica G1, etc.) que excede lo que esta rama aborda. Esta entrega cubre la parte lógica que el propio issue marcó como pendiente tras #168/#177: colisión AABB reutilizable (`crewCollision.ts`), puertas funcionales que conectan y pueden separar las once salas con estado abierto/cerrado (`CREW_ROOM_EDGES`, `crewRoutes.ts`) y una estructura de zonas navegables por sala lista para que la navegación del issue #129 la consuma. No se tocó mobiliario, dimensiones ni renderer; cero arte nuevo. | [PR #231](https://github.com/jmmana/Agent-Viewer/pull/231), rama `feat/crew-170-spatial-collisions` sobre main `b41548b`, fusionado. 23 Vitest nuevos (`crewCollision.test.ts`, `crewRoutes.test.ts`) sobre 660 Vitest totales aprobados; typecheck, build app/lib/CLI, check de paquete y SDK Python aprobados localmente. Detalle abajo, en "Continuación #170". |
| [#167](https://github.com/jmmana/Agent-Viewer/issues/167) | No se cierra. El motor 2.5D (`renderCrewRoom.ts`, integrado antes por #194 a partir de #177) mezclaba escena, props, sprites y HUD en una sola función. Se separó en `crewLightingLayer.ts` (paleta de sombreado compartida), `crewSceneLayer.ts` (fondo, paredes, piso y puertas), `crewPropsLayer.ts` (muebles), `crewSpriteLayer.ts` (pose/parpadeo del actor) y `crewHudLayer.ts` (insignia de presencia, único HUD dibujado en canvas); `crewRenderPrimitives.ts` aloja la única primitiva compartida (polígono relleno y trazado). `renderCrewRoom.ts` queda como orquestador con la misma API pública; `renderCrewRoom.test.ts` y `crewViewport.test.ts` pasan sin modificar, confirmando salida de píxeles y orden de dibujo idénticos. Se agregó además `crewSceneLifecycle.ts`, un controlador de montar/actualizar/desmontar independiente de React (RAF + ResizeObserver), con su propia prueba de extremo a extremo contra `renderCrewRoom`; no se cableó en `CrewStage.tsx` porque un primer intento de hacerlo introdujo una regresión real en `crew-sprites.spec.ts` (ver sección de riesgos), así que esa integración queda para un cambio aparte. El issue sigue abierto porque falta evidencia visual completa (capturas/snapshots) del ciclo de vida en runtime con arte final. | [PR #233](https://github.com/jmmana/Agent-Viewer/pull/233), rama `feat/crew-167-renderer-modules`. 6 Vitest nuevos de capas (25 pruebas) y de ciclo de vida (6 pruebas); 667 Vitest y ~754 Node en total (1 falla preexistente y no relacionada en `tests/cli.test.mjs`, reproducida también en main sin estos cambios); 20 E2E de Crew en Chrome aprobados; typecheck, builds app/lib/CLI, `check:package` y SDK Python aprobados. |
| [#166](https://github.com/jmmana/Agent-Viewer/issues/166) | Cerrado. El switch `cartoon`/`crew`, el renderer `CrewStage` aislado y la API embebida ya estaban en main (PR #175, #177, #189, #190, #191, consolidados por #194 y posteriores). Esta entrega agrega el contrato formal ([ADR-002](../adr/ADR-002-crew-two-mode-architecture.md)) que faltaba y dos pruebas nuevas que antes no existían: límites de import verificados por escaneo de código (`tests/crew-mode-boundary-166.test.mjs`) y veinte alternancias de modo sin fuga de temporizadores, eventos ni preferencias de Crew (`tests/lib/crewModeContract166.test.tsx`). | Rama `feat/crew-166-mode-contract`. Contrato y matriz de aceptación: [ISSUE-166-ACCEPTANCE.md](ISSUE-166-ACCEPTANCE.md). Ver el PR del issue para la salida completa de CI. |
| [#158](https://github.com/jmmana/Agent-Viewer/issues/158) | Parcial (Refs, no Closes). Suite de benchmarks del renderer Crew existente: costo JS puro de `renderCrewRoom` por sala x nivel de agentes (`npm run crew:perf:bench`, compuerta en `tests/lib/crewPerfBudget.test.ts`), fugas deterministas en 100 ciclos de montaje/desmontaje de sala (`tests/lib/crewMountLeak.test.tsx`) y captura informativa de FPS pintados/heap en Chromium real (`npm run crew:perf:browser`). No se creó arte ni escenas nuevas. Umbrales propuestos explícitamente (el issue no fija números): 8ms de costo JS con 50 agentes, 0 RAF/listeners huérfanos tras 100 ciclos, 1 canvas simultáneo. Pendiente: dispositivos físicos/móvil real, LRU de assets y culling (no existen hoy en el renderer; son de otros issues), certificación G1. Metodología, cifras capturadas y umbrales: [PERFORMANCE.md](PERFORMANCE.md). |
| [#168](https://github.com/jmmana/Agent-Viewer/issues/168) | Cerrado. Catálogo de once salas, puertas y llegadas locales, selector con búsqueda bilingüe, teclado, estados de ocupación y aislamiento de eventos. La escena seleccionada es la única visible en Crew; Caricatura conserva su renderer y store. | [PR #222](https://github.com/jmmana/Agent-Viewer/pull/222), merge `2d3c43e`. 19 E2E Chrome y 607 Vitest; lint, builds app/lib/CLI, check de paquete y pruebas Python reportados en el PR. Los checks previos al merge `verify`, `cli-node-22` y `crew-browser` pasaron en ambos runs. Contrato, aceptación y capturas: [ISSUE-168-ACCEPTANCE.md](ISSUE-168-ACCEPTANCE.md). |
| [#171](https://github.com/jmmana/Agent-Viewer/issues/171) | Cerrado. Preferencias, enlaces, restablecimiento, navegación y controles de Crew quedan integrados con estado por instancia y almacenamiento validado. | [PR #221](https://github.com/jmmana/Agent-Viewer/pull/221), merge `119002d`. Checks previos al merge `verify`, `cli-node-22` y `crew-browser` pasaron en ambos runs. Criterios y límites: [ISSUE-171-ACCEPTANCE.md](ISSUE-171-ACCEPTANCE.md). |
| [#172](https://github.com/jmmana/Agent-Viewer/issues/172) | Cerrado. La auditoría documenta procedencia y destino de 53 assets más la referencia, preservación de originales, renderer independiente y los 1.584 SVG como estudios, no animación final. #43 continúa abierto como draft y no se ha fusionado como reemplazo de Caricatura. | [PR #218](https://github.com/jmmana/Agent-Viewer/pull/218), merge `920dce7`. Comparación fuente/banco 54/54 y 11 pruebas de integridad; checks previos al merge `verify`, `cli-node-22` y `crew-browser` pasaron en ambos runs. Auditoría: [ISSUE-172-ACCEPTANCE.md](ISSUE-172-ACCEPTANCE.md). |

La asignación de cada issue en desarrollo se decide por agente y modelo según su complejidad. En esta tanda, GPT-6 Luna atendió la auditoría y documentación acotadas, y GPT-6.1 Sol la implementación de código. El coordinador revisa el alcance, integra los cambios y gestiona el cierre.

Crew continúa en Beta; estos cierres no certifican G1 ni convierten los prototipos del banco en arte final. Las siguientes secciones conservan cortes históricos: las fechas, ramas y estados de issues descritos allí no sustituyen los cierres actuales de la tabla superior.

## Continuación #170: colisiones, puertas funcionales y zonas navegables

Verificación previa: se releyó el issue #170 completo y el código real de `src/crew/` en `origin/main` (`a042a9b`) antes de tocar nada. Se confirmó lo que había anticipado una investigación previa: el catálogo de once salas (`CrewRoomDefinition`, de #168/#177) ya existía con mobiliario, capacidad y un único umbral de puerta decorativo por sala, pero sin colisión AABB reutilizable, sin que las puertas conectaran de verdad una sala con otra, y sin ninguna estructura de rutas o zonas navegables. El issue #170 en sí sigue abierto como documento de alcance amplio (cuatro cámaras coherentes o placeholder explícito, evidencia en video del hito G1, etc.); esta rama solo cierra la brecha lógica de colisiones/puertas/rutas que el propio issue señaló como pendiente, sin tocar arte, mobiliario ni el renderer.

Cambios, todos aditivos sobre datos ya existentes, sin nuevos props ni sprites:

- `src/crew/crewCollision.ts`: colisión AABB (`aabbFromCenter`, `aabbsOverlap`, `aabbContains`, `pointInAABB`) sobre las huellas de mobiliario (`propAABB`) y los límites de cada sala (`roomBoundsAABB`); `crewAgentCollides` decide si un agente puede ocupar un punto; `overlappingFurniturePairs` es una verificación de integridad de datos (confirmada vacía en las once salas); `doorAABB` da la caja del umbral de cada puerta.
- `src/crew/crewModel.ts`: se agregó `CREW_ROOM_EDGES`, un árbol de expansión de diez enlaces que conecta las once salas en un solo edificio (recepción como nodo central). Cada puerta ahora lleva `connectsTo` (la sala vecina) y `edgeId`. La puerta original de cada sala conserva exactamente su id y posición previos (verificado contra las pruebas de geometría ya existentes de `renderCrewRoom.test.ts`); las salas con más de un vecino (recepción, desarrollo, descanso, cafetería, reuniones, investigación, calidad) reciben puertas adicionales en offsets nuevos, verificados contra el mobiliario de cada sala.
- `src/crew/crewRoutes.ts`: capa de conectividad reutilizable. `buildCrewRoomGraph` construye el grafo de adyacencia entre salas; `defaultCrewDoorStates`/`setCrewDoorState`/`isCrewEdgeOpen` llevan un estado abierto/cerrado inmutable por enlace (todas abiertas por defecto); `findCrewRoomRoute`/`reachableCrewRooms` hacen BFS entre salas respetando puertas cerradas, de forma que una puerta cerrada puede separar completamente dos salas, como pedía el issue. `buildCrewWalkGraph` convierte la grilla de posiciones libres de cada sala (`crewPresenceSlots`) en un grafo navegable de 4 conexiones, consciente del mobiliario, con una conexión de respaldo al vecino más cercano para que ninguna llegada de puerta quede aislada; `findCrewWalkPath` es BFS sobre ese grafo. Ambas estructuras son datos puros que el futuro issue #129 (navegación de agentes) puede consumir directamente.

Pruebas nuevas: `tests/lib/crewCollision.test.ts` (primitivas AABB, cero solapamientos de mobiliario en las once salas, colisión de límites y mobiliario en varias salas) y `tests/lib/crewRoutes.test.ts` (construcción del grafo, alcance completo del edificio con todo abierto, ruta directa y ruta de varios saltos, una puerta cerrada que aísla una sala hoja o que divide el árbol en dos mitades exactas, y conectividad/ruta de las zonas navegables en seis de las once salas).

Validación local: `npm run lint` (tsc) sin errores; `npm run test:unit` (Vitest) 660 pruebas aprobadas en 39 archivos, incluidas las 23 nuevas; `npm run test:node` 751 pruebas de node:test, con un fallo intermitente de un test de rendimiento (`event-store.test.mjs`, umbral de 5 s bajo carga de máquina compartida) y otro de un test de timing (`claude-hook.test.mjs`) que pasaron ambos al ejecutarse en aislamiento, sin relación con este cambio (no se tocó `server/` en esta rama); `python3 tests/test_python_sdk.py` 23 pruebas aprobadas; `npm run build`, `npm run build:lib`, `npm run build:cli` y `npm run check:package` aprobados; `npm audit --omit=dev` sin vulnerabilidades. No se ejecutó la suite E2E de Playwright: el issue pide lógica de colisión/puertas/rutas, no una verificación visual nueva, y las pruebas de render existentes (`renderCrewRoom.test.ts`) siguen aprobando sin cambios porque la geometría original de cada puerta no se movió.

Pendiente, explícitamente fuera de esta entrega: arte final de las salas, animación real de atravesar una puerta, y el propio issue #129 de navegación de agentes, que ahora puede apoyarse en `crewRoutes.ts` en vez de empezar desde cero. #170 permanece abierto.

## Historial técnico de implementación

Nuevo incremento de orientación: cada CEO usa el facing de su snapshot y la cámara; se comparten imágenes por orientación, y el parpadeo solo aparece en rostros frontales respecto al observador. La prueba de cuatro actores comprueba la imagen dibujada para cada número de presencia y que cambiar cámara no modifica el snapshot. [Contrato y matriz de 16 combinaciones](FACING.md).

Validación: 379 Node aprobados y uno omitido, 579 Vitest y 17 E2E; tipos y builds app/lib/CLI/paquete aprobados. Evidencia: [captura frontal](evidence/facing-118/facing-front.png), [cámara derecha](evidence/facing-118/facing-right.png), [vídeo](evidence/facing-118/runtime.mp4). Los originales no se modificaron. La orientación discreta no implementa un giro animado ni caminar.

### Incremento anterior

Último incremento: atlas original RGBA de cuatro fotogramas y controlador temporal de parpadeo frontal, con anclajes por fotograma, carga diferida, recuperación ante error y respeto por movimiento reducido. El reloj se detiene al ocultar la pestaña o salir de Crew. No escribe eventos, tareas ni métricas. [Recurso, procedencia y prompt](../../assets/crew/clips/README.md). [Captura](evidence/blink-117/ceo-blink.png) y [vídeo](evidence/blink-117/runtime.mp4).

Validación local tras incorporar main `8218153`: 334 Node aprobados y uno omitido, 575 Vitest y 16 E2E aprobados, tipos, compilaciones app/lib/CLI, paquete e integridad del banco aprobados. [PR #205](https://github.com/jmmana/Agent-Viewer/pull/205). Las pruebas cubren límites temporales, fin/repetición de clips, cancelación, pestaña oculta, movimiento reducido dinámico, cuatro rectángulos dibujados y atlas ausente. Los clips laborales y de locomoción, otros roles y G1 siguen pendientes.

### Historial de integración

El [PR #194](https://github.com/jmmana/Agent-Viewer/pull/194) integra los incrementos #175, #177, #182, #183, #185, #186, #187, #189, #190 y #191 en main, conservando sus commits. Merge `a867cd2`, 2026-10-09. Se reconciliaron los cambios recientes de CLI, contratos, almacenamiento y CI; los tres conflictos de configuración conservaron ambos conjuntos de comprobaciones. #175 quedó fusionado automáticamente y los PR apilados restantes se cerraron por integración, tras verificar que sus commits son ancestros de main. #43 no se fusionó. Ningún issue funcional se cerró.

[CI previo al merge](https://github.com/jmmana/Agent-Viewer/actions/runs/37923447700) y [CI posterior en main](https://github.com/jmmana/Agent-Viewer/actions/runs/37923645463) aprobados, incluidos navegador, CLI Node 22.13, Python y contenedores. Validación local del conjunto integrado: 275 Node aprobados y uno omitido, 522 Vitest, 12 E2E y 12 Python; tipos, compilaciones app/lib/CLI y paquete aprobados.

El incremento posterior incorpora el piloto estático del CEO en cuatro vistas, con carga bajo demanda, conservación de marcadores ante fallos y pruebas de limpieza. Validación local: 276 Node aprobados y uno omitido, 528 Vitest y 14 E2E. Compilaciones app/lib/CLI, typecheck, integridad del banco y paquete aprobados. Los PNG originales no se modificaron. Evidencia en [ceo-118](evidence/ceo-118/).

Crew sigue en Beta. G1 no está certificado: faltan arte final de salas, animaciones verdaderas, integración completa de acciones, rendimiento y dispositivos físicos. Los apartados históricos siguientes registran cada incremento con los pendientes que existían entonces.

## Base verificada en el corte histórico de la primera ejecución

- Repositorio: jmmana/Agent-Viewer. Main observado: `637b1f5`.
- Rama actual: `feat/crew-facing-118`, basada en main `30c0514`.
- Controlador y parpadeo: #205, integrado en main.
- Piloto estático anterior: `feat/crew-character-assets-118`, integrado mediante #195.
- Banco: `feat/crew-asset-bank-172`, basado en `5cb4643` de #191.
- Cámara Caricatura: `fix/crew-cartoon-camera-166`, basada en `cccc4bd` de #190.
- Presencia: `feat/crew-presence-focus-155`, basada en `2c7461d` de #189.
- API embebida: `feat/crew-embedded-api-171`, basada en `b607d83` de #187.
- Enlaces/reset: `feat/crew-navigation-links-reset-171`, basada en `dfdb060` de #186.
- QA anterior: `test/crew-domain-continuity-159`, basada en `0832cfa` de #185.
- Foco: `feat/crew-camera-focus-156`, basada en `1e1e591` de #183.
- Persistencia: `feat/crew-navigation-persistence-171`, basada en `0b513ea` de #182.
- Rama anterior: `feat/crew-camera-gestures-156`, basada en `3e18d2a` de #177.
- PR #175 y #177: abiertos, borrador, checks anteriores verdes. No fusionados.
- #174 y #176: fusionados en main. #162, #163 y #164: fusionados solamente en la rama de #43.
- #43 sigue abierto en borrador. Manifest contrastado: 53 recursos `prototype`, 11 personajes, 20 muebles, 13 electrónicos, 9 efectos.
- Guías visuales y manifest ausentes de esta rama: consultados con `git show origin/feat/visual-assets-v1:...`, sin importar código legacy. Sus reglas de cuadrícula antigua quedan subordinadas al ADR Crew.
- No existía IMPLEMENTATION-STATUS.md antes de esta ejecución.

## Cambios de esta ejecución

Gestos por pointerId con pinch anclado al centro de los dedos, paneo simultáneo, transición a un dedo y limpieza por cancelación, pérdida de captura, blur y cambio de sala. Rueda nativa no pasiva con zoom continuo y normalización de unidades. Teclado: flechas, +, -, Home. Cámaras siguen separadas por sala, sin escritura en dominio. Aviso de prototipo adaptable a móvil y nombres de vistas ES/EN. Dos pruebas Playwright y job de CI con capturas.

## Pruebas y evidencia

- Typecheck `npm run lint`: aprobado.
- `npm test`: 61 pruebas node y 441 Vitest aprobadas.
- `npm run build`, `npm run build:lib`, `npm run check:package`: aprobados. Advertencia existente de bundle de aplicación mayor de 500 kB.
- `npm audit --omit=dev`: cero vulnerabilidades.
- SDK Python: 3 pruebas aprobadas; wheel construido, instalado e importado en venv temporal.
- `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`: 2 pruebas aprobadas en Chrome headless. Desktop 1920×1080: dos salas por cuatro vistas, rueda, teclado, cambio de sala y regreso de Caricatura. Móvil emulado 320×800: pinch mediante CDP TouchEvent, cancelación y aislamiento por sala.
- Capturas: [CEO](evidence/camera-156/ceo-front.png), [Desarrollo](evidence/camera-156/development-right.png), [pinch móvil](evidence/camera-156/mobile-pinch.png), [regreso Caricatura](evidence/camera-156/cartoon-return.png). Las ocho vistas se regeneran en test-results.
- QA restante: dispositivos físicos/iOS, continuidad completa LIVE/REPLAY/telemetría, animaciones, proporciones de arte final, rendimiento y vídeo del hito G1. Pruebas de navegación no equivalen a paridad total.
- Docker local: daemon no respondió a la consulta; builds pendientes de CI.
- Implementación: commit `75f2da7`, [PR #182](https://github.com/jmmana/Agent-Viewer/pull/182), abierto sobre #177. [CI del último commit](https://github.com/jmmana/Agent-Viewer/actions/runs/37868883704) aprobado, incluyendo Docker y navegador.

## Estado de los 55 issues en el corte histórico de la primera ejecución

Este inventario refleja el estado al redactar la primera ejecución. Desde entonces, #116, #168, #171 y #172 se cerraron con las evidencias enlazadas en el bloque superior.

| Issue | Estado verificable |
| --- | --- |
| [#115](https://github.com/jmmana/Agent-Viewer/issues/115) | 53 originales recuperados con hashes y procedencia; banco aislado, revisión artística e integración pendientes. |
| [#116](https://github.com/jmmana/Agent-Viewer/issues/116) | Guías históricas en #43 requieren adaptación al ADR Crew. |
| [#117](https://github.com/jmmana/Agent-Viewer/issues/117) | Pipeline independiente de caminar implementado en rama de revisión: cuatro atlas CEO originales de ocho cuadros, manifiesto versionado, importación solo prototype, carga por sala/rol/orientación, precarga y cancelación. Pruebas y PNG/MP4 en [FRAME-PIPELINE.md](FRAME-PIPELINE.md). Sin aprobación de arte final ni locomoción de #118/#129; integración/CI pendientes del PR de esta entrega. |
| [#118](https://github.com/jmmana/Agent-Viewer/issues/118) | Piloto CEO estático de cuatro vistas integrado en el renderer Crew; animaciones y orientación de dominio pendientes. |
| [#119](https://github.com/jmmana/Agent-Viewer/issues/119) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#120](https://github.com/jmmana/Agent-Viewer/issues/120) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#121](https://github.com/jmmana/Agent-Viewer/issues/121) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#122](https://github.com/jmmana/Agent-Viewer/issues/122) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#123](https://github.com/jmmana/Agent-Viewer/issues/123) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#124](https://github.com/jmmana/Agent-Viewer/issues/124) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#125](https://github.com/jmmana/Agent-Viewer/issues/125) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#126](https://github.com/jmmana/Agent-Viewer/issues/126) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#127](https://github.com/jmmana/Agent-Viewer/issues/127) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#128](https://github.com/jmmana/Agent-Viewer/issues/128) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#129](https://github.com/jmmana/Agent-Viewer/issues/129) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#130](https://github.com/jmmana/Agent-Viewer/issues/130) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#131](https://github.com/jmmana/Agent-Viewer/issues/131) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#132](https://github.com/jmmana/Agent-Viewer/issues/132) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#133](https://github.com/jmmana/Agent-Viewer/issues/133) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#134](https://github.com/jmmana/Agent-Viewer/issues/134) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#135](https://github.com/jmmana/Agent-Viewer/issues/135) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#136](https://github.com/jmmana/Agent-Viewer/issues/136) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#137](https://github.com/jmmana/Agent-Viewer/issues/137) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#138](https://github.com/jmmana/Agent-Viewer/issues/138) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#139](https://github.com/jmmana/Agent-Viewer/issues/139) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#140](https://github.com/jmmana/Agent-Viewer/issues/140) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#141](https://github.com/jmmana/Agent-Viewer/issues/141) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#142](https://github.com/jmmana/Agent-Viewer/issues/142) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#143](https://github.com/jmmana/Agent-Viewer/issues/143) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#144](https://github.com/jmmana/Agent-Viewer/issues/144) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#145](https://github.com/jmmana/Agent-Viewer/issues/145) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#146](https://github.com/jmmana/Agent-Viewer/issues/146) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#147](https://github.com/jmmana/Agent-Viewer/issues/147) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#148](https://github.com/jmmana/Agent-Viewer/issues/148) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#149](https://github.com/jmmana/Agent-Viewer/issues/149) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#150](https://github.com/jmmana/Agent-Viewer/issues/150) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#151](https://github.com/jmmana/Agent-Viewer/issues/151) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#152](https://github.com/jmmana/Agent-Viewer/issues/152) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#153](https://github.com/jmmana/Agent-Viewer/issues/153) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#154](https://github.com/jmmana/Agent-Viewer/issues/154) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#155](https://github.com/jmmana/Agent-Viewer/issues/155) | Adaptador read-only y marcadores con foco en esta rama; asignación espacial provisional. Bridge de tareas/reuniones completo pendiente. |
| [#156](https://github.com/jmmana/Agent-Viewer/issues/156) | Gestos, rueda y teclado en #182; foco de escritorios/monitores y pan acotado en esta rama. Foco de actores y arte final pendientes. |
| [#157](https://github.com/jmmana/Agent-Viewer/issues/157) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#158](https://github.com/jmmana/Agent-Viewer/issues/158) | Benchmarks del renderer existente agregados (ver bloque superior y [PERFORMANCE.md](PERFORMANCE.md)); dispositivos físicos, LRU/culling y certificación G1 siguen pendientes. |
| [#159](https://github.com/jmmana/Agent-Viewer/issues/159) | Doce E2E: cámara, persistencia, SSE, importación de log, vacío LIVE, lifecycle, API embebida, regreso Caricatura y cuatro tamaños. QA final de arte y dispositivos pendiente. |
| [#160](https://github.com/jmmana/Agent-Viewer/issues/160) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#161](https://github.com/jmmana/Agent-Viewer/issues/161) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#166](https://github.com/jmmana/Agent-Viewer/issues/166) | Contrato y selector en PR #175, borrador. |
| [#167](https://github.com/jmmana/Agent-Viewer/issues/167) | Renderer independiente en PR #177, borrador. |
| [#168](https://github.com/jmmana/Agent-Viewer/issues/168) | Registro y selector de 11 salas prototipo en #177. |
| [#169](https://github.com/jmmana/Agent-Viewer/issues/169) | Aislamiento y fit prototipo en #177; QA completa pendiente. |
| [#170](https://github.com/jmmana/Agent-Viewer/issues/170) | 11 layouts locales prototipo en #177; faltan colisiones y arte final. |
| [#171](https://github.com/jmmana/Agent-Viewer/issues/171) | Persistencia en #183, enlaces/reset en #187, API embebida controlada en esta rama. Validación final y preferencias de accesibilidad pendientes. |
| [#172](https://github.com/jmmana/Agent-Viewer/issues/172) | Inventario fusionado (#176); banco de originales en #194, integración y QA visual en runtime pendientes. |
| [#173](https://github.com/jmmana/Agent-Viewer/issues/173) | ADR fusionado (#174); validación gráfica final pendiente. |

## Continuación #157: accesibilidad, controles y audio (wiring)

`crewPreferences.ts` crece de forma aditiva sobre el contrato de #171 (solo
`reducedMotion`) con `muted`, `volume`, `highContrast`, `subtitles`, `hudSize`
y `accessibilityPreset`; un JSON previo sin estos campos sigue leyéndose con
sus defaults seguros. `applyCrewAccessibilityPreset()` aplica de una sola vez
una combinación pensada para lector de pantalla o baja visión.

`CrewStage` agrega los controles correspondientes (checkbox de alto contraste,
checkbox de subtítulos, mute/volumen, select de tamaño de HUD, select de
preset) dentro de un `<details>` colapsado por defecto para no empujar el
canvas fuera del viewport en móvil (320-390px); "Reducir movimiento" queda en
la barra principal, sin mover su posición. Los cambios de sala y de cámara se
anuncian en una región `aria-live` visible solo si `subtitles` está activo
(si no, sigue en el DOM para lectores de pantalla pero oculta visualmente).
El canvas usa una paleta de alto contraste alternativa (`crewContrast.ts`),
con relación de contraste WCAG calculada y probada (AA para el tema estándar,
AAA para el de alto contraste).

Limitación conocida y explícita: Crew no tiene ningún motor de audio propio
todavía. Mute/volumen son wiring puro, sin ningún sonido real que controlar;
quedan listos para que #150 (que depende de este issue) los lea cuando agregue
el motor de audio real. No se creó ningún efecto de sonido ni música nueva.

Validación: typecheck; 751 pruebas node (750 aprobadas, una omitida) y 648
Vitest aprobadas, incluidas 17 pruebas nuevas de contraste WCAG y de las
preferencias nuevas. 23/23 E2E Chrome aprobados, incluida una prueba nueva de
navegación solo por teclado de los controles de accesibilidad. Builds
app/lib/CLI y `check:package` aprobados; `npm audit --omit=dev` sin
vulnerabilidades. SDK Python: 22/23 aprobadas; la prueba restante
(`test_live_server_integration`) falla por un `tsx` ausente en
`node_modules/.bin` de este entorno, una condición preexistente del worktree
sin relación con este cambio.

No se hizo prueba manual con VoiceOver/NVDA ni en dispositivo físico; la
cobertura de teclado es automatizada (Playwright, foco + Espacio/Enter/flechas
sobre los controles nuevos), no un lector de pantalla real. #166 ya se cerró
(contrato de arquitectura); #169 y #156 siguen abiertos como issues aunque su
código base (aislamiento de escena, cámara) ya existe en main. Este PR no toca
esos archivos. #157 no se cierra del todo: falta la verificación manual con
lector de pantalla real y el audio verdadero depende de #150.

## Próximos tres pasos

1. #118/#117: completar contrato de orientación y clips animados a partir del piloto estático, sin contar poses como animaciones.
2. #150: motor de audio real de Crew, consumiendo el wiring de mute/volumen ya dejado listo por #157.
3. #159: servidor SSE real, reproducción temporal, rendimiento y dispositivos físicos antes de aprobar G1.

Hecho en esta ejecución, ya no es parte de los tres próximos pasos: #155, bridge de tareas/reuniones/aprobación e insignia LIVE/DEMO/REPLAY (ver tabla superior); queda abierto para animación real y redacción completa en modo minimizado.

## Riesgos y decisiones

- Este PR está apilado sobre #177 y #175; integrar en orden y reconciliar con main antes de release.
- G1 no está aprobado. No iniciar despliegue masivo de arte ni cerrar oficinas por geometría provisional.
- Mantener cuatro vistas discretas Canvas2D; no son órbita 3D.
- Personajes y muebles finales no están dibujados en estas escenas. No alterar ni fusionar automáticamente #43.
- #167: cablear `crewSceneLifecycle.ts` en `CrewStage.tsx` (reemplazando su efecto de RAF/ResizeObserver en línea) rompió `crew-sprites.spec.ts` de forma reproducible (el parpadeo/pose cargado no llegaba a dibujarse tras el primer cuadro). Se revirtió ese cableado antes de abrir el PR; el módulo queda nuevo, probado y sin usar en la UI hasta que un cambio aparte investigue la causa y lo integre sin esa regresión.

## Continuación #171

Modo y oficina elegidos sobreviven a recarga y a la salida/regreso desde Caricatura. La clave `agent-viewer-crew-navigation-v1` contiene solamente versión, modo y sala. La clave de cámaras existente se conserva sin migración destructiva. JSON corrupto, versiones futuras y salas eliminadas usan valores seguros. Fallos de almacenamiento no bloquean las funciones de preferencias.

Validación: typecheck; 61 pruebas node y 446 Vitest; 4 E2E Chrome aprobados, incluyendo recarga en Development/back/120%, regreso desde Caricatura y sala eliminada. Builds app/lib y validación de paquete ejecutados. La recuperación de almacenamiento bloqueado está probada a nivel del módulo, no de toda la aplicación. No se cerró #171: quedan reset general, deep links y API embebida. Implementación `b563258`, [PR #183](https://github.com/jmmana/Agent-Viewer/pull/183), abierto sobre #182. [CI](https://github.com/jmmana/Agent-Viewer/actions/runs/37869062554) aprobado en el último commit, con Docker y navegador.

## Continuación #156: foco y límites

Selector de escritorios/monitores de la sala actual, con foco basado en la misma proyección y escala de encuadre del renderer. Un ID de otra sala no cambia la cámara. El paneo conserva el centro de la geometría local dentro del viewport con 32 píxeles de margen; esto prioriza poder recuperar la sala sobre un paneo ilimitado. ResizeObserver corrige también la cámara persistida al reducir la ventana. El zoom por botones conserva el centro de vista.

Validación local: typecheck; 61 pruebas node y 449 Vitest; 5 E2E Chrome aprobados; build app aprobado. Nuevas pruebas verifican foco en cuatro vistas, aislamiento de IDs, paneo extremo y resize 1920→320. [Captura de foco CEO](evidence/camera-156/ceo-desk-focus.png). Foco de agentes pendiente hasta disponer de anclajes visuales reales en Crew. Implementación `e337f33`, [PR #185](https://github.com/jmmana/Agent-Viewer/pull/185), abierto sobre #183; [CI](https://github.com/jmmana/Agent-Viewer/actions/runs/37869312615) aprobado en el último commit.

## Continuación #159: dominio, lifecycle y evidencia de runtime

Nueve E2E aprobados en Chrome headless. Datos sintéticos de prueba recibidos por la ruta SSE interceptada en el navegador o por importación JSONL mantienen presencia, estado CODING, 1.500 tokens y coste 0,250 al cambiar salas y modos. No se contacta ningún proveedor ni se envían estos datos a un servidor. LIVE sin eventos permanece vacío en las once salas. ResizeObserver de Crew pasa de uno a cero al salir. Cuatro anchos emulados (320, 390, 768 y 1920) con controles ES y canvas dentro del viewport.

Limitaciones precisas: el test SSE prueba cliente, ingestión y UI mediante interceptación de red, no reconexión contra servidor real. Importación JSONL prueba el estado resultante, no un reproductor temporal completo. La prueba de lifecycle cubre observadores, no un perfil completo de memoria. No son cuatro dispositivos físicos.

Playwright conserva vídeos WebM de las pruebas en test-results, publicados por CI. [MP4 del runtime](evidence/camera-156/runtime-navigation.mp4): navegación por CEO/Development, cuatro vistas, foco, regreso a Caricatura y recarga. Es una demostración de geometría prototipo, no de arte o animaciones finales.

Reproducción: ejecutar `npm run dev` y, en otra terminal, `PLAYWRIGHT_CHANNEL=chrome npm run crew:capture` (o instalar Chromium con `npx playwright install chromium` y omitir la variable). Genera `test-results/crew-demo/runtime.webm`. Conversión opcional con ffmpeg: `ffmpeg -i test-results/crew-demo/runtime.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart runtime-navigation.mp4`.

Validación final de esta continuación, incluida la corrección móvil: `npm run lint`, 61 pruebas node, 449 Vitest, nueve E2E y build app aprobados. Builds lib/paquete y Docker aprobados previamente en la base #185; CI reejecuta los checks tras la corrección. Implementación inicial `0e46a0f`, [PR #186](https://github.com/jmmana/Agent-Viewer/pull/186), abierto sobre #185.


### Hallazgo de QA visual móvil

La captura de 320 px tras iniciar en escritorio mostró la barra lateral superpuesta a Crew. La primera aserción de tamaño del canvas no detectaba la oclusión. Corregido en App mediante visibilidad responsive de la barra únicamente en modo Crew, sin modificar el componente/renderer Caricatura ni su estado de apertura. La actividad sigue accesible desde la pestaña de actividad. El E2E ahora exige que `elementFromPoint` en el centro del canvas sea el propio canvas, además de revisar tamaño y visibilidad. Corrección validada: typecheck, 61 node, 449 Vitest, nueve E2E y build app aprobados. [Captura móvil corregida](evidence/camera-156/crew-mobile-es.png).

## Continuación #171: enlaces directos y restablecimiento

Enlaces `?visualMode=crew&crewRoom=development` prevalecen sobre la selección guardada. Una sala desconocida abre Dirección y muestra un aviso bilingüe, sin pantalla vacía; seleccionar otra sala limpia el aviso. La navegación actualiza enlaces activos con replaceState conservando parámetros ajenos como `mode=live`. El enlace compartible contiene solo modo visual/sala y LIVE si corresponde, sin copiar credenciales, fragmentos ni datos de sesión.

Restablecer Crew vuelve a Dirección, limpia todas sus cámaras y mantiene Crew abierto; no reinicia agentes, coste ni tokens. La recarga conserva el reset, incluso al haber entrado por un enlace a otra oficina.

Validación: typecheck, 61 node, 452 Vitest, diez E2E Chrome, builds app/lib y validación de paquete aprobados. Captura móvil con nuevos controles revisada a 320 px. Base #186 en `dfdb060` tiene CI aprobado (run 37869826733). Falta API embebida; #171 no se cierra. Implementación `9b93f94`, [PR #187](https://github.com/jmmana/Agent-Viewer/pull/187), abierto sobre #186. CI aprobado para `b607d83` (run 37870217242).

## Continuación #171/#166: API embebida

AgentOffice permite `visualMode`, `crewRoomId`/`onCrewRoomChange` y `crewCameras`/`onCrewCamerasChange`. Caricatura sigue por defecto; no se crea un segundo store al alternar renderers. Preferencias sin controlar viven por instancia y sobreviven al cambio de modo mientras AgentOffice permanezca montado. Las propiedades controladas solicitan cambios al host; los mapas recibidos se validan sin mutarlos.

La biblioteca no accede a localStorage para Crew ni altera la URL del host. Controles con IDs únicos y enlaces de la app ocultos. [Contrato y ejemplo](EMBEDDED-API.md). Los mensajes personalizados del host aún no sustituyen los controles Crew ES/EN; foco de agentes sigue pendiente y no se afirma paridad visual final.

Validación: typecheck, 61 node, 456 Vitest, once E2E Chrome, builds app/lib y validación del paquete aprobados. Cuatro tests de API cubren StrictMode, rechazo de cambios por el host, estado inválido y dos instancias sin almacenamiento global. E2E adicional verifica ambas oficinas, modo y móvil. Capturas revisadas: [dos instancias](evidence/camera-156/embedded-two-offices.png), [móvil](evidence/camera-156/embedded-mobile.png). Implementación `ac027f5`, [PR #189](https://github.com/jmmana/Agent-Viewer/pull/189), abierto sobre #187. CI en curso al publicar.

## Continuación #155/#156: presencia local verificable

Marcadores numerados representan exclusivamente agentes del snapshot asignados a la sala seleccionada; el panel permite enfocarlos. No representan personajes ni animaciones finales. Proyección determinista por ID y snapshot, sin usar coordenadas del mapa Caricatura ni modificar eventos. Las huellas de muebles compartidas con el renderer excluyen posiciones ocupadas; las dimensiones de props se intercambian correctamente en vistas laterales. Se informa la capacidad excedida en lugar de superponer marcadores. No son reservas de sillas ni rutas; las posiciones pueden cambiar al variar ocupación y son provisionales.

Validación: 61 node, 461 Vitest, once E2E, typecheck, builds app/lib y validación de paquete aprobados. Tests incluyen 0/50 agentes, orden de replay determinista, colisiones de huellas, exceso de capacidad, aislamiento de sala y foco desde SSE/log sin alterar consumo. [Captura de presencia](evidence/camera-156/development-presence.png).

Hallazgo independiente: el scaffold desmonta OfficeCanvas al cambiar de modo y su cámara es estado interno; por tanto se pierde al regresar. Las pruebas anteriores de regreso verificaban datos y canvas, no esa cámara. Se debe corregir esta regresión antes de aprobar G1; no está solucionada en este PR de presencia. Implementación `be7c4f3`, [PR #190](https://github.com/jmmana/Agent-Viewer/pull/190), abierto sobre #189. CI en curso al publicar.

## Corrección #166/#171: cámara Caricatura

El contenedor conserva una memoria de cámara Caricatura por instancia y la restaura al volver desde Crew. Adaptación opcional en OfficeCanvas para recibir esa memoria; no modifica canvasRenderer, escenas, personajes, estilos ni controles. Evita que el primer resize/fit borre la cámara restaurada; los cambios reales de viewport siguen ajustando el encuadre. Al salir el viewport se desmonta y conserva su limpieza de RAF/listeners, sin dibujarlo oculto.

Cambio compartido necesario: App y AgentOffice proveen la memoria; OfficeCanvas conserva el comportamiento anterior cuando no se le proporciona. Pruebas StrictMode verifican pan/zoom/orientación y memorias distintas. E2E nuevo compara el PNG del canvas antes/después de rotar, acercar, arrastrar, entrar a Crew y regresar; son idénticos bajo reduced-motion y LIVE vacío.

Validación: typecheck, 61 node, 463 Vitest, doce E2E, builds app/lib y paquete aprobados. Corrige el hallazgo documentado en #190. La prueba de igualdad de píxeles cubre ese escenario determinista, no toda la paridad visual con agentes activos. Implementación `80ce444`, [PR #191](https://github.com/jmmana/Agent-Viewer/pull/191), abierto sobre #190. CI en curso al publicar.

## Banco de recursos originales, #172/#115

Recuperados 53 archivos y la referencia del CEO desde el commit `355e9194bd83d8b741bc65d5b58a897d320ee584` de #43. Se conservan bytes, licencia, procedencia y dimensiones. El manifiesto independiente clasifica todas las poses como estáticas y los recursos como prototipos; no se importa código del renderer anterior ni se aprueba arte automáticamente. Ver [banco y procedimiento](../../assets/crew/README.md).

La validación offline corre en CI y detecta cambios de hash, rutas inválidas, duplicados, dimensiones inconsistentes, licencias desconocidas y clasificaciones inventadas de animación o perspectiva. Diez pruebas nuevas. Verificación local: 71 node y 463 Vitest, typecheck, builds de aplicación y biblioteca y comprobación del paquete aprobados. Los 12 E2E también aprobaron en el CI de esta rama, junto con el SDK Python y las dos imágenes Docker.

El banco no se carga en runtime. Falta la revisión visual por recurso y la adaptación al contrato espacial Crew antes de utilizarlo en salas. G1 y los issues permanecen abiertos.

Implementación del banco: `a878c29`, [PR #194](https://github.com/jmmana/Agent-Viewer/pull/194), abierto sobre #191. [CI](https://github.com/jmmana/Agent-Viewer/actions/runs/37923058757) aprobado para el commit de implementación, incluidos navegador, Python y Docker.

## Piloto ilustrado del CEO, #118/#117

Solo agentes con rol boss presentes en la sala reciben la pose original correspondiente al preset de cámara. Se conserva el número de presencia y el orden de profundidad compartido con los muebles. El piloto no interpreta orientación ni acciones del dominio. Otros roles y recursos faltantes usan marcadores. Una sala vacía no carga imágenes.

Los módulos diferidos cargan únicamente la vista solicitada; al cambiar sala, vista o modo se limpian callbacks de imagen y se descartan resultados tardíos. Fallos de descarga o dimensiones inconsistentes mantienen el marcador y un mensaje ES/EN. La biblioteca empaqueta las cuatro imágenes en módulos diferidos; la aplicación produce archivos con hash. El banco pasa de bank-only a source-bank sin alterar hashes ni archivos originales.

Pruebas nuevas: selección por rol, cancelación antes de resolver el módulo, errores de importación/imagen, dimensiones, integridad del anclaje, render sin imagen y sala vacía. Dos E2E verifican drawImage con cada original, ausencia de descargas en otra sala, las cuatro vistas, móvil, regreso Caricatura y PNG no disponible. Se revisaron capturas de las cuatro vistas y móvil; [MP4 de ejecución](evidence/ceo-118/four-views.mp4) obtenido del vídeo Playwright de la misma prueba. Una primera ejecución detectó un selector de status ambiguo, corregido usando aria-live en el texto de arte, y un fallo intermitente de interacción embebida no reproducido en la repetición específica ni en la suite completa posterior. CI debe confirmar el conjunto.

## Parpadeo frontal y controlador de fotogramas, #117/#118

Se añadió un atlas derivado mediante image_gen integrado, preservando los originales. El PNG mide 1070 × 1470 y contiene cuatro celdas diferentes. La medición de los pies opacos detectó desplazamientos de hasta ocho píxeles entre columnas; el contrato compensa con anclajes por cuadro, sin alterar el archivo. Se revisaron identidad, expresiones y ejecución en la sala Crew. Sigue clasificado prototype.

El controlador puro selecciona cuadros por tiempo transcurrido y duraciones explícitas. La integración programa solo la próxima transición, sin RAF continuo de animación. Movimiento reducido usa el original estático; pestaña oculta cancela el temporizador y reanuda desde ojos abiertos. Un atlas fallido conserva el original y una sala sin CEO no lo descarga.

No se implementaron caminar, giros, sentarse, teclear ni llamada. No se convierte el parpadeo en prueba de animación laboral ni de orientación del dominio. #117/#118 continúan abiertos.

La integración `6583a3f` incorpora main `8218153` sin conflictos. Se repitieron tipos, tests, builds app/lib/CLI y paquete sobre esa base; todos aprobaron localmente. CI del PR valida también Python, CLI Node 22.13 y contenedores.

## Orientación individual, #118/#155

La proyección de presencia conserva facing como dato de solo lectura. El renderer resuelve la pose por actor; una misma sala puede mostrar varios CEO con diferentes direcciones. La carga se comparte para cada orientación necesaria y conserva las imágenes aún utilizadas cuando cambian otros actores. Valores ausentes usan SE y valores inválidos conservan marcador.

Se corrigió la equivalencia previa entre nombre de cámara y nombre de imagen: cámara right lleva +X a +Y, cuya proyección corresponde al lateral izquierdo. Las pruebas y las capturas reflejan esa convención. El parpadeo se habilita por rostro visible, no por el nombre de la cámara. No se cambian contratos de eventos ni se generan estados de trabajo.

Orientación integrada mediante [PR #206](https://github.com/jmmana/Agent-Viewer/pull/206), merge `4f8f079`, implementación `81928a3`. [CI del PR](https://github.com/jmmana/Agent-Viewer/actions/runs/37966265396) aprobado, incluidos navegador, CLI y contenedores.

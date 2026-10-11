# Motor visual Crew independiente: escenas, ciclo de vida y renderer, #167

Epic: [#114](https://github.com/jmmana/Agent-Viewer/issues/114). Depende de CREW-001 ([#166](https://github.com/jmmana/Agent-Viewer/issues/166), contrato formal de dos modos, cerrado en [PR #229](https://github.com/jmmana/Agent-Viewer/pull/229)) y CREW-008, identificado en esta auditoria como [#173](https://github.com/jmmana/Agent-Viewer/issues/173) (ADR de camara 2.5D), **ya cerrado a su propio alcance** ([ADR-001](../adr/ADR-001-crew-camera.md), auditoria en `IMPLEMENTATION-STATUS.md`). Ninguna de las dos dependencias bloquea este cierre.

Este registro audita, con escepticismo, cuanto del motor pedido por #167 ya existia en `main` antes de esta sesion y cierra los huecos reales encontrados: una prueba de independencia de DOM que faltaba y la evidencia visual reproducible que el issue exige explicitamente.

## Contrato de interfaces del motor (ya implementado, verificado en esta auditoria)

El motor Crew es un arbol de renderizado propio bajo `src/crew/`, sin ninguna dependencia del renderer Caricatura (`src/engine/`, `src/components/OfficeCanvas.tsx`):

| Responsabilidad | Modulo | Prueba dedicada |
| --- | --- | --- |
| Escena (fondo, paredes, piso, puertas) | `crewSceneLayer.ts` | `tests/lib/crewSceneLayer.test.ts` |
| Props / mobiliario | `crewPropsLayer.ts` | `tests/lib/crewPropsLayer.test.ts` |
| Actores (sprite, parpadeo, pose) | `crewSpriteLayer.ts` | `tests/lib/crewSpriteLayer.test.ts` |
| Iluminacion / paleta compartida | `crewLightingLayer.ts` | `tests/lib/crewLightingLayer.test.ts` |
| HUD (insignia de presencia, superposicion de llamada) | `crewHudLayer.ts`, `crewCallLayer.ts` | `tests/lib/crewHudLayer.test.ts`, `tests/lib/crewCallLayer.test.ts` |
| Camara (zoom, pan, 4 orientaciones) | `crewCamera.ts` | `tests/lib/crewCamera.test.ts` |
| Layout / catalogo de salas | `crewModel.ts` (`CREW_ROOMS`) | `tests/lib/crewModel.test.ts` |
| Colision y navegacion | `crewCollision.ts`, `crewNavigation.ts` | `tests/lib/crewCollision.test.ts`, `tests/lib/crewNavigation.test.ts` |
| Gestos (pinch/wheel/teclado) | `crewGestures.ts` | `tests/lib/crewGestures.test.ts` |
| Audio | `crewAudioEngine.ts`, `crewAudioAssets.ts`, `useCrewAudio.ts` | `tests/lib/crewAudioEngine.test.ts`, `tests/lib/crewAudioAssets.test.ts`, `tests/lib/useCrewAudio.test.tsx` |
| Ciclo de vida independiente de React (RAF + ResizeObserver) | `crewSceneLifecycle.ts` | `tests/lib/crewSceneLifecycle.test.ts` |
| Orquestador de render | `renderCrewRoom.ts` (compone las capas anteriores, sin logica de dibujo propia mas alla de camara/proyeccion) | `tests/lib/renderCrewRoom.test.ts` |

Esta separacion ya se entrego en [PR #233](https://github.com/jmmana/Agent-Viewer/pull/233) (refs #167): `renderCrewRoom.ts` paso de mezclar escena/props/sprites/HUD en una sola funcion a ser solo el orquestador que calcula camara y proyeccion y delega el dibujo. Esta auditoria confirmo que esa separacion sigue intacta en `main` y que cada capa conserva su prueba unitaria propia.

**Orden de capas** (documentado en `docs/crew/visual-style-contract.md`, seccion de contrato de render, y verificado linea por linea contra `renderCrewRoom.ts`): fondo -> paredes/piso de la sala -> rejilla de piso -> puertas -> props y actores intercalados por profundidad local `(x + y)` (asi un actor detras de un escritorio queda correctamente ocluido) -> insignia de presencia y superposicion de llamada por actor (HUD). No existe hoy una capa de particulas (el motor solo tiene un sprite ilustrado, el del CEO); `docs/crew/PERFORMANCE.md` ya documenta que el culling de particulas queda pendiente de arte futuro, no de este issue.

**Ciclo de vida**: `crewSceneLifecycle.ts` (`mountCrewScene`) es un controlador de montar/actualizar/desmontar independiente de React, con su propia suite de 6 pruebas (incluida una de extremo a extremo contra `renderCrewRoom`). `CrewStage.tsx` mantiene hoy su propio efecto en linea equivalente (RAF + `ResizeObserver`, mismo contrato de limpieza); la migracion de `CrewStage` a `crewSceneLifecycle.ts` quedo pendiente desde PR #233 porque un primer intento rompio `crew-sprites.spec.ts`. Esto **no bloquea el cierre de #167**: el contrato de ciclo de vida (montar, actualizar, desmontar sin fugas) ya esta implementado, probado de forma aislada, y el camino de produccion (`CrewStage`) cumple el mismo contrato de limpieza, verificado por `crewMountLeak.test.tsx` (ver abajo). Queda anotado como limpieza tecnica futura, no como deuda de este issue.

## Independencia real frente a Caricatura (confirmado, con una prueba nueva)

- **Analisis estatico de imports** (`tests/crew-mode-boundary-166.test.mjs`, ya existente): Caricatura nunca importa `src/crew/`; Crew nunca importa `engine/canvasRenderer`, `engine/livingOfficeEngine`, `engine/visualLayout`, `engine/visualMotion` ni `components/OfficeCanvas`; `renderFurnitureItem` de Caricatura sigue sin exportarse.
- **Nueva en esta sesion** (`tests/lib/crewEngineIndependence167.test.tsx`): monta `CrewStage` vacio (cero agentes, el valor por defecto) para cada una de las once salas del catalogo y confirma, a nivel de DOM real (no solo de imports), que no aparece ningun elemento exclusivo de `OfficeCanvas.tsx` (`av-canvas-root`, `av-toolbar`, `av-tool-btn`), que hay exactamente un canvas, y que al desmontar ese canvas desaparece. 11 casos nuevos, verdes.
- **Nueva en esta sesion**, a nivel E2E (`tests/e2e/crew-engine-167.spec.ts`): navega a la app real (no un showroom ni un fixture aislado) en modo Crew sobre la sala `finance`, genuinamente vacia (cero agentes en el store global, mockeado con snapshot/stream vacios), y confirma lo mismo en el navegador real: boton "Crew · Beta" activo, "Empty office. Furniture remains visible.", un solo canvas, cero marcadores de Caricatura en el DOM, cero errores de pagina. Corrido en escritorio (1440x900) y movil (390x844).

## Fugas de RAF/listeners al montar y desmontar (ya cubierto, sin cambios)

`tests/lib/crewMountLeak.test.tsx` (issue #158, ya en `main`) monta y desmonta `CrewStage` 100 veces recorriendo las once salas, con agentes vacios por defecto, y verifica con temporizadores falsos que no queda ningun `requestAnimationFrame` pendiente tras cada desmontaje y que los listeners de `window`/`document` quedan balanceados. `tests/e2e/crew-domain.spec.ts` (prueba "libera observadores Crew al salir...") confirma lo mismo en un navegador real contando instancias vivas de `ResizeObserver` en cuatro anchos de viewport (320, 390, 768, 1920) y verificando que ese conteo vuelve a 0 al volver a Caricatura.

## Recarga y fallo de assets (ya cubierto, sin cambios)

`useCrewSprite.ts` y `useCrewPropImages.ts` exponen un estado `failed` explicito por vista/prop (un `onerror` de imagen marca el fallo sin reintentar silenciosamente) y cancelan la carga pendiente al cambiar de sala, de vista o al desmontar (el efecto de React limpia la suscripcion devuelta por `loadCrewSprite`/`loadCrewPropImage`). `tests/lib/useCrewSprite.test.tsx` y `tests/e2e/crew-desktop.spec.ts` ("movimiento reducido, fallback bilingue y cancelacion al salir") cubren el camino de fallo con un `page.route(...).abort()` real sobre el PNG.

## Contextos embebido, escritorio y movil (ya cubierto, sin cambios)

`tests/e2e/crew-embedded.spec.ts` monta dos instancias independientes de `AgentOffice` en modo Crew sin eventos compartidos. `tests/e2e/crew-domain.spec.ts` y la evidencia nueva de esta sesion cubren 320/390/768/1440/1920 px. `tests/e2e/crew-catalog.spec.ts` confirma que una sala sin agentes asignados (`finance`, `coffee`, `reception`) sigue dibujando su mobiliario con el aviso "Empty office".

## Evidencia visual reproducible generada en esta sesion

Capturas reales (no mockups), generadas corriendo `tests/e2e/crew-engine-167.spec.ts` contra la app real en modo Crew aislado (no showroom, no modo legado), guardadas en el repo:

- [Escritorio, sala Finanzas vacia](evidence/engine-167/empty-room-desktop.png) (1440x900).
- [Movil, misma sala](evidence/engine-167/empty-room-mobile.png) (390x844).
- [Grabacion corta de la corrida real](evidence/engine-167/empty-room-runtime.webm) (video de Playwright, escritorio).

Las tres evidencian: suelo/paredes/puertas renderizados, mobiliario original (sin actores, sala genuinamente vacia), boton "Crew · Beta" activo junto al boton "Cartoon" (ambos modos coexisten en la UI pero no comparten arbol de render), y cero elementos de Caricatura en el DOM mientras Crew esta activo.

## Reproduccion y validacion

```sh
npm ci
npm run lint
npx vitest run tests/lib/crewEngineIndependence167.test.tsx tests/lib/crewMountLeak.test.tsx
node --test tests/crew-mode-boundary-166.test.mjs
PLAYWRIGHT_CHANNEL=chrome npx playwright test --config=playwright.crew167.config.ts
```

Ejecucion aislada de este issue en el puerto 3167 (`playwright.crew167.config.ts`), siguiendo el mismo patron que `playwright.crew118.config.ts`, para no interferir con un servidor de desarrollo compartido en 3000.

## Limitaciones

Chrome headless sobre macOS y movil emulado, sin dispositivo fisico ni Safari certificado (misma limitacion documentada en el resto del epico). No se migro `CrewStage` a `crewSceneLifecycle.ts`; queda anotado como limpieza tecnica futura, sin issue propio todavia. No se toco arte, assets, personajes ni salas concretas: eso corresponde a otros issues de la Ola 2/3 del epico #114.

## Trazabilidad

Auditoria de este agente sobre `main` en la fecha de este commit. Revision del mantenedor autoriza el cierre final.

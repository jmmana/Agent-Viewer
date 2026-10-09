# Aceptación de arquitectura de #166

Fecha: 2026-10-09. Alcance: contrato formal de dos modos independientes
(Caricatura/Crew) y verificación con pruebas de los criterios del issue.
Referencia: [issue #166](https://github.com/jmmana/Agent-Viewer/issues/166),
[ADR-002](../adr/ADR-002-crew-two-mode-architecture.md),
[ADR-001](../adr/ADR-001-crew-camera.md) y [API embebida](EMBEDDED-API.md).
Esta aceptación es de arquitectura y contrato; no certifica arte final ni el
hito G1 del Epic #114.

## Qué encontró esta auditoría antes de escribir código

El switch `cartoon`/`crew`, el renderer `CrewStage` aislado, la API embebida de
`AgentOffice` (`visualMode`, `crewRoomId`, `crewCameras`, `crewPreferences`) y
la corrección de la cámara de Caricatura al volver desde Crew ya estaban
integrados en `main` (PR #175, #177, #189, #190, #191, consolidados por #194 y
posteriores; ver [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)). Lo que
faltaba para #166 en concreto:

1. Un documento formal de arquitectura/contrato dedicado a la decisión de dos
   modos (existía ADR-001 para cámara/escenas de #173, pero ninguno para la
   independencia de modos de #166). Resuelto con [ADR-002](../adr/ADR-002-crew-two-mode-architecture.md).
2. Una prueba que ejecute literalmente la alternancia repetida que pide el
   criterio de aceptación ("entrar/salir 20 veces") y compruebe que no hay
   fuga de temporizadores, pérdida de eventos ni reinicio de preferencias de
   Crew (sala, cámara, `reducedMotion`). No existía antes de este issue.
3. Una prueba que haga cumplir los límites de import del ADR mediante escaneo
   de código fuente, en vez de solo documentarlos en prosa.

## Matriz de criterios verificables del issue

| Criterio del issue | Estado | Evidencia |
| --- | --- | --- |
| Dos opciones visibles y accesibles: Caricatura y Crew | Satisfecho (ya en main) | `src/App.tsx` (grupo de botones `aria-pressed`), `AgentOfficeProps.visualMode` en `src/lib/AgentOffice.tsx` |
| Caricatura conserva capturas y comportamientos anteriores; no se altera al construir Crew | Satisfecho | `tests/crew-mode-boundary-166.test.mjs` (Caricatura nunca importa `src/crew`); `tests/e2e/crew-camera.spec.ts` (comparación de píxeles antes/después de Crew) |
| Entrar/salir veinte veces no duplica listeners, no pierde eventos, no reinicia métricas ni tareas | **Nuevo en este issue** | `tests/lib/crewModeContract166.test.tsx`: temporizador estable tras 20 alternancias con stream creciente; evento final no perdido; sala/cámara/`reducedMotion` controlados y no controlados sobreviven 20 ciclos; dos instancias no se filtran estado entre sí |
| API embebida conserva el default previo y admite elección explícita del modo | Satisfecho | `EMBEDDED-API.md`; `tests/lib/crewEmbedded.test.tsx` (`cartoon` por defecto, props controladas) |
| El nuevo renderer no depende de la grilla visual antigua | Satisfecho, ahora verificado con test | `tests/crew-mode-boundary-166.test.mjs`: Crew no importa `canvasRenderer`, `livingOfficeEngine`, `visualLayout`, `visualMotion` ni `OfficeCanvas`; `renderFurnitureItem` sigue sin exportarse |

## Pruebas y evidencia agregadas en este issue

- `tests/crew-mode-boundary-166.test.mjs` (node:test, 4 pruebas): escanea
  `src/engine/`, `src/components/` y `src/crew/` en busca de imports cruzados
  prohibidos y confirma que `renderFurnitureItem` sigue siendo privado a
  `canvasRenderer.ts`. Se verificó que detecta regresiones reales: revirtiendo
  temporalmente la privacidad de un import, la prueba falla como se espera
  (verificación manual durante el desarrollo, revertida antes del commit).
- `tests/lib/crewModeContract166.test.tsx` (Vitest, 5 pruebas):
  - veinte alternancias `cartoon`/`crew` con un stream de eventos que crece en
    cada ciclo no duplican el temporizador de `OfficeStore` y no pierden el
    último evento aplicado;
  - sala, cámara y `reducedMotion` controlados por un host quedan igual tras
    veinte alternancias;
  - `reducedMotion` propio (no controlado) no se reinicia a su valor por
    defecto tras veinte alternancias;
  - la preferencia controlada de movimiento reducido no se corrompe al
    alternar veinte veces con `prefers-reduced-motion` del sistema activo;
  - dos instancias de `AgentOffice` no se filtran estado entre sí cuando solo
    una de ellas alterna de modo veinte veces.

  Se verificó que esta prueba detecta regresiones reales: forzando
  artificialmente que el efecto del temporizador se recreara en cada cambio de
  `visualMode` sin limpieza, la primera prueba fallo con 22 temporizadores
  activos en vez de 2 (verificación manual durante el desarrollo, revertida
  antes del commit; el código de producción no cambió).

## Validación ejecutada

Ver el PR de este issue para la salida completa y real de cada comando de CI
(`npm run lint`, `npm test`, `npm run build`, `npm run build:lib`,
`npm run check:package`, `npm audit --omit=dev`, SDK Python y E2E). Esta
auditoría no repite esa salida aquí para no duplicar números que puedan
desactualizarse; el PR es la fuente de verdad de la ejecución concreta.

## Qué queda fuera de este cierre

Arte final de salas y personajes, animaciones de trabajo/reunión, rendimiento
en dispositivos físicos y el hito G1 del Epic #114 no son parte del alcance de
#166 y siguen abiertos en sus propios issues (#117, #118, #155, #156, #159 y
los de arte referenciados en [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)).
Las aproximadamente veinte banderas de configuración de la app de demostración
(`src/App.tsx`) no se auditaron una por una: se verificó el contrato de
alternancia de modos en sí (temporizadores, eventos, preferencias de Crew), que
es lo que pide el criterio de aceptación del issue.

## Recomendación

Los cinco criterios verificables del issue tienen implementación trazable en
`main` y, los dos que carecían de verificación explícita (alternancia
repetida sin fugas, límites de import), ahora tienen pruebas automatizadas que
se ejecutan en cada CI. Recomiendo cerrar #166 tras revisión del PR y CI verde.

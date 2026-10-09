# ADR-002 - Arquitectura de dos modos independientes: Caricatura y Crew

- **Issue:** [#166](https://github.com/jmmana/Agent-Viewer/issues/166)
- **Epic:** [#114](https://github.com/jmmana/Agent-Viewer/issues/114)
- **Estado:** Aceptado para el alcance de arquitectura/contrato. No certifica G1 ni arte final de Crew.
- **Fecha:** 2026-10-09
- **Relacionado:** [ADR-001](ADR-001-crew-camera.md) (cámara y escenas locales de Crew), [EMBEDDED-API.md](../crew/EMBEDDED-API.md) (contrato de props de `AgentOffice`).

## 1. Decisión

Caricatura y Crew son **dos renderers independientes y seleccionables**, nunca
un skin del mismo árbol visual. La selección vive en un único campo
`visualMode: 'cartoon' | 'crew'`, con `'cartoon'` como valor por defecto en
toda integración existente. Cambiar `visualMode` **nunca** recrea el store de
dominio (`OfficeStore`), nunca reinicia el stream de eventos, el `usage`
calculado por el host ni la selección de agente; solo cambia qué componente de
presentación se monta dentro de la misma sección `<AgentOffice>` (o del mismo
contenedor en la app de demostración).

Esta decisión ya estaba implementada de forma incremental en varias ramas
(contrato inicial en PR #175, renderer independiente en PR #177, API embebida
en PR #189, corrección de cámara de Caricatura en PR #191, todas integradas en
`main` por PR #194 y posteriores). Este documento formaliza el contrato que
esos PR fueron construyendo, para que futuras ramas de Crew (#167, #168 a
#172, #118, #155, #156, #159 y las de arte final) tengan una referencia única
de qué invariantes no pueden romper.

## 2. Contrato tipado

```ts
// src/crew/crewModel.ts
type VisualMode = 'cartoon' | 'crew';

// src/lib/AgentOffice.tsx (API pública de la biblioteca @warlockcode/agent-viewer)
interface AgentOfficeProps {
  visualMode?: VisualMode;              // 'cartoon' por defecto; no rompe integraciones existentes
  crewRoomId?: string;                  // sala controlada; sin prop, AgentOffice conserva su propio estado
  onCrewRoomChange?: (roomId: string) => void;
  crewCameras?: CrewCameraByRoom;       // cámaras controladas por sala
  onCrewCamerasChange?: (cameras: CrewCameraByRoom) => void;
  crewPreferences?: CrewPreferences;    // { version: 1; reducedMotion: boolean }
  onCrewPreferencesChange?: (preferences: CrewPreferences) => void;
  // mode, events, agents, usage, showUsage, selectedAgentId... son comunes a ambos renderers.
}
```

`mode` (`professional | showcase`) controla la semántica de eventos y es
ortogonal a `visualMode`: ningún renderer decide qué eventos existen ni
calcula cifras de consumo. `visualMode` controla exclusivamente qué
presentación dibuja ese mismo estado.

## 3. Límites de import (verificados con prueba, no solo documentados)

| Regla | Donde se hace cumplir |
| --- | --- |
| `src/engine/**` y `src/components/**` (Caricatura) nunca importan nada de `src/crew/**` | `tests/crew-mode-boundary-166.test.mjs` |
| `src/crew/**` nunca importa `engine/canvasRenderer`, `engine/livingOfficeEngine`, `engine/visualLayout`, `engine/visualMotion` ni `components/OfficeCanvas` | `tests/crew-mode-boundary-166.test.mjs` |
| `renderFurnitureItem` (dibujo de muebles de Caricatura) permanece privado a `canvasRenderer.ts`, nunca exportado | `tests/crew-mode-boundary-166.test.mjs` |
| El punto de selección de modo (`AgentOffice.tsx`) es el único archivo que conoce ambos renderers | `tests/crew-mode-boundary-166.test.mjs` |

Estas reglas se comprueban escaneando el código fuente real en cada CI, no
mediante una lista mantenida a mano: una regresión de import queda atrapada
automáticamente.

## 4. Invariantes de estado al alternar modos

1. **Un solo store de dominio.** `OfficeStore` se crea una vez por instancia
   de `AgentOffice` (`useRef`, nunca recreado al cambiar `visualMode`) y su
   temporizador de 250 ms vive mientras el componente esté montado. Alternar
   modos veinte veces no debe crear temporizadores adicionales.
2. **Ningún evento se pierde ni se reaplica.** El stream de eventos sigue
   siendo la única fuente de verdad; el renderer activo solo lee el snapshot
   más reciente.
3. **Las métricas y tareas del host no se tocan.** `usage` es una prop que el
   host calcula fuera de la biblioteca (ADR de "la biblioteca nunca calcula
   consumo"); cambiar `visualMode` no la recalcula ni la oculta más que por
   `showUsage`. En la app de demostración, `simState.tasks` vive por encima
   del switch de `visualMode` y no se reinicia al alternar.
4. **Las preferencias de presentación de Crew (sala, cámara por sala,
   `reducedMotion`) sobreviven a la salida y vuelta desde Caricatura.** Sin
   props controladas, `AgentOffice` las conserva en su propio estado interno
   mientras permanezca montado; con props controladas, el host decide su
   persistencia (`localStorage`, estado de aplicación, etc.) y Crew nunca
   impone su propio almacenamiento global.
5. **Caricatura conserva su cámara propia** (pan/zoom/rotación) a través de
   `cartoonCameraMemory`, incluso tras una vuelta desde Crew (corregido en PR
   #191, tras la regresión documentada en PR #190).
6. **Dos instancias de `AgentOffice` en la misma página no comparten estado**
   ni leen/escriben preferencias globales entre sí.

Las cinco primeras reglas antes no tenían una prueba que las ejecutara
literalmente veinte veces como pide el criterio de aceptación del issue; la
sexta sí estaba cubierta. La sección 5 detalla qué se agregó.

## 5. Movimiento reducido (`reduced-motion`)

Dos preferencias coexisten y nunca se mezclan incorrectamente:

- **Preferencia del sistema** (`prefers-reduced-motion: reduce`), leída de
  forma independiente por Caricatura (`src/components/OfficeCanvas.tsx`) y por
  Crew (`src/crew/useCrewBlink.ts`). Cada renderer tiene su propia lectura
  porque no comparten código; esto es intencional, no una omisión.
- **Preferencia propia de Crew** (`CrewPreferences.reducedMotion`), que el
  usuario puede activar manualmente. El sistema siempre tiene prioridad: un
  valor propio en `false` nunca reactiva animación si el sistema pide
  reducirla (ver comentario en `src/crew/crewPreferences.ts`).

Verificado con pruebas: `useCrewBlink` cancela el temporizador activo al pasar
a `reducedMotion = true` y no lo recrea mientras siga activo
(`crewPreferences171.test.tsx`); la preferencia propia no se reinicia a su
valor por defecto tras entrar y salir de Crew repetidamente, controlada o no
por el host (`crewModeContract166.test.tsx`, nuevo en este issue).

## 6. Qué no decide este ADR

- No aprueba arte final, animaciones de trabajo/reunión ni el hito G1 de Crew.
- No cambia el contrato de cámara/escenas de ADR-001.
- No agrega ni quita ninguna de las más de veinte banderas de estado/UI de la
  app de demostración (tema, locale, piso secundario, charla ambiental,
  velocidad de reproducción, etc., contadas en `src/App.tsx`); esas banderas
  viven por encima del switch de `visualMode` y, al no depender de él, ya
  sobreviven a la alternancia de modos sin cambios de este issue. Lo nuevo
  aquí es la prueba que verifica el ciclo de alternancia en sí (temporizadores,
  eventos, preferencias de Crew), no una prueba por cada bandera individual de
  la demo.

## 7. Evidencia y pruebas

Ver [ISSUE-166-ACCEPTANCE.md](../crew/ISSUE-166-ACCEPTANCE.md) para la matriz
completa de criterios de aceptación del issue con su evidencia.

# Consolidación del PR #43 como banco de arte y gate de retiro de Caricatura (#161)

Relacionado: [Epic #114](https://github.com/jmmana/Agent-Viewer/issues/114) (VIS-47), [#172](https://github.com/jmmana/Agent-Viewer/issues/172) (cerrado), [#166](https://github.com/jmmana/Agent-Viewer/issues/166) (cerrado), [PR #43](https://github.com/jmmana/Agent-Viewer/pull/43), [#162](https://github.com/jmmana/Agent-Viewer/pull/162), [#163](https://github.com/jmmana/Agent-Viewer/pull/163), [#164](https://github.com/jmmana/Agent-Viewer/pull/164).

**Fecha de esta consolidación:** 2026-10-11. **Naturaleza de este documento:** proceso y gobierno, no arte. Este issue no crea ningún recurso nuevo, no implementa código de producto y no retira nada. Su único entregable es documental: fijar qué quedó realmente integrado del PR #43 y definir, como checklist verificable, bajo qué condiciones objetivas se podría algún día evaluar el retiro del modo Caricatura, sin ejecutarlo ahora.

## 1. Qué es (y qué no es) el banco de arte del PR #43

[PR #43](https://github.com/jmmana/Agent-Viewer/pull/43) (`feat/visual-assets-v1`) sigue hoy, verificado con `gh pr view 43`, en estado **DRAFT, abierto, base `main`, sin merge commit**. No se ha fusionado como reemplazo total de Caricatura ni se propone fusionar aquí. Tres PR incrementales se fusionaron únicamente dentro de la rama de #43, nunca en `main`:

| PR | Resultado | Alcance real |
| --- | --- | --- |
| [#162](https://github.com/jmmana/Agent-Viewer/pull/162) | `MERGED` en `feat/visual-assets-v1` | Auditoría de recuperación, validador de layouts de sala y `scripts/register-office-clip.mjs`. |
| [#163](https://github.com/jmmana/Agent-Viewer/pull/163) | `MERGED` en `feat/visual-assets-v1` | Preview de `frameFiles` reales en el showroom de PR #43, sin generar animación final. |
| [#164](https://github.com/jmmana/Agent-Viewer/pull/164) | `MERGED` en `feat/visual-assets-v1` | Piloto de 4 muebles ilustrados inyectados en el **Canvas legado de Caricatura** (`characterStyle="office-crew"`), explícitamente clasificado como ensayo técnico, no como Modo Crew. |

El rescate y la clasificación completa de los 53 recursos runtime del manifest de PR #43 (11 personajes, 20 muebles, 13 electrónicos, 9 efectos) ya se hizo y se cerró formalmente en el issue [#172](https://github.com/jmmana/Agent-Viewer/issues/172) (`PR #218`, fusionado a `main`). Ese trabajo es la fuente canónica y este documento no lo repite ni lo contradice, solo lo referencia:

- [`ASSET-MIGRATION-PR43.md`](ASSET-MIGRATION-PR43.md): matriz de trazabilidad por ID, archivo fuente, estado y destino en Crew de cada uno de los 53 recursos.
- [`ISSUE-172-ACCEPTANCE.md`](ISSUE-172-ACCEPTANCE.md): auditoría de aceptación de #172, con comparación de bytes 54/54 contra el commit fuente y la confirmación de que #43 no se fusiona como reemplazo total.

Verificación de cordura reproducida hoy contra `assets/crew/asset-manifest.json`: **53 recursos runtime, todos con `status: "prototype"`, ninguno `"approved"`**, más la referencia de estilo `reference.ceo`. Ningún recurso del banco cambió de estado desde el cierre de #172.

### Regla de uso del banco

El banco de PR #43 es **material de referencia y prototipo**, consumible solo por el renderer Crew independiente (`src/crew/`) mediante adaptadores explícitos, nunca importando el motor de dibujo legado. Dos usos concretos que ya existen hoy en Crew, ambos documentados como alcance parcial en `docs/crew/IMPLEMENTATION-STATUS.md`:

- El piloto estático del CEO (4 vistas, poses `idle`/`work`/`phone`) integrado vía `src/crew/crewSprites.ts` (#117/#118).
- Dos piezas de mobiliario (`furniture.desk-executive`, `furniture.plant-floor`) renderizadas como imagen real en la sala Dirección vía `src/crew/crewPropImages.ts` (#115).

El resto del banco (51 de 53 piezas) sigue sin integrarse al renderer Crew; integrarlo pertenece a los issues de producción de arte del épico (#118-127, #130-141), no a este.

**Prohibido explícitamente, hoy y en el futuro, salvo decisión de arquitectura separada:** tratar [PR #164](https://github.com/jmmana/Agent-Viewer/pull/164) o el `characterStyle="office-crew"` del Canvas legado como si fueran el Modo Crew nuevo. Son ensayos técnicos sobre la grilla antigua, conservados como referencia de arte reutilizable, nunca como implementación del motor aislado que exige el Epic #114.

## 2. Gate de retiro de Caricatura

Este gate es una lista de condiciones **verificables, no una decisión de retiro**. El modo Caricatura permanece disponible y funcional durante toda la ejecución del épico. El Epic #114, sección 8, es explícito: **"Caricatura NO se elimina automáticamente"**; su retiro sería una decisión posterior y explícita del propietario, respaldada por paridad verificable, documentada en un issue nuevo dedicado exclusivamente a esa decisión. **Este documento no retira Caricatura, no autoriza su retiro y no decide el retiro**: solo deja escrito, con evidencia verificable en el repositorio, qué condiciones tendrían que cumplirse todas a la vez antes de que esa decisión futura sea siquiera elegible para evaluarse.

Cada fila cita una ruta de archivo real del repositorio como evidencia de su estado actual. Si cualquiera de esas rutas desaparece o dejan de ser ciertas las cifras citadas, `tests/crew-pr43-consolidation-161.test.mjs` falla, para que este documento no quede desalineado de la realidad del código como ya le pasó antes a otras secciones de docs/crew/IMPLEMENTATION-STATUS.md (ver su propio historial de autocorrecciones).

| # | Eje exigido por el Epic #114 / issue #161 | Estado actual | Evidencia verificable |
| --- | --- | --- | --- |
| 1 | Requisitos completos del Epic (sección 8, "Criterios de aceptación finales NO negociables") satisfechos y cerrados, no solo redactados. | **Pendiente.** De los 55 issues hijos indexados en el Epic, solo #166, #167, #168, #171, #172, #173 (a su alcance literal) y el pipeline de #117 están cerrados. La mayoría de #118-161 sigue abierta o parcial. | `docs/crew/IMPLEMENTATION-STATUS.md` (tabla "Avances y cierres verificados", fuente única de verdad de qué está cerrado hoy). |
| 2 | 10-11 escenas funcionales (arte final, mobiliario, pantallas y vida) en las salas del catálogo, cada una aislada. | **Pendiente.** El catálogo estructural de 11 salas con puertas y navegación está cerrado (#168, #170), pero arte real integrado en el renderer solo existe en 2 de 53 piezas, en 1 de 11 salas (Dirección). Las demás 10 salas no tienen mobiliario ilustrado real todavía. | `src/crew/crewModel.ts` (definición de las 11 salas y `CREW_ROOM_EDGES`), `src/crew/crewPropImages.ts` (único renderer de mobiliario con imagen real), `docs/crew/ASSET-MIGRATION-PR43.md`. |
| 3 | Cámara propia por sala: zoom continuo, pan acotado, 4 ángulos, foco y reset, con arte final en cada ángulo. | **Lógica cumplida, arte pendiente.** La cámara en sí (#156/#173) está auditada y cerrada a su alcance técnico: zoom por rueda/pinch, pan acotado, 4 presets `front/right/back/left`, foco de escritorio y persistencia por sala. Lo que falta es arte ilustrado final por cada ángulo, no la mecánica de cámara. | `src/crew/crewCamera.ts`, `tests/lib/crewCamera.test.ts`, `tests/e2e/crew-camera.spec.ts`, `tests/e2e/crew-facing.spec.ts`. |
| 4 | Animaciones reales cuadro a cuadro para los 6 roles (caminar, sentarse, teclear, hablar, etc.), no solo poses estáticas. | **Pendiente.** Solo el CEO tiene un pipeline de caminar prototype (32-64 cuadros, #117/#118/#276); los otros 5 roles (Planner, Developer, Analyst, Reviewer, Finance) solo tienen una pose `idle-front` estática, sin ningún cuadro de movimiento. | `src/crew/crewClips.ts`, `docs/crew/FRAME-PIPELINE.md`, `docs/crew/ASSET-MIGRATION-PR43.md` (fila "character", 11 entradas, todas `prototype`). |
| 5 | 6 roles con variantes de apariencia real (género, piel, cabello, vestuario) configurables, no un catálogo de marcadores de posición. | **Pendiente.** El editor de personajes (#127) existe como herramienta y contrato, pero opera explícitamente sobre un catálogo cuyo propio código declara `status: 'placeholder'` en cada opción, a la espera de que #125/#126 entreguen el catálogo y arte reales. | `src/crew/crewCharacterCatalog.ts`, `docs/crew/visual-style-contract.md`. |
| 6 | LIVE sin tareas/conversaciones/tokens ficticios en ninguna sala; DEMO y REPLAY siempre rotulados de forma explícita, nunca inferidos. | **Parcial.** El puente de eventos de solo lectura y la insignia explícita `LIVE`/`DEMO`/`REPLAY` (decidida por el host, nunca inferida de los datos) ya existen (#155), pero su cobertura visual está limitada a las salas que ya tienen arte real integrado. | `src/crew/crewEventBridge.ts`, `tests/lib/crewEventBridge.test.ts`. |
| 7 | Accesibilidad (teclado, reduced motion, lectores de pantalla) y rendimiento verificados en dispositivos físicos reales, no solo en navegador headless o jsdom. | **Pendiente para dispositivos físicos.** Teclado, `reducedMotion`, LRU de assets y culling de actores/mobiliario fuera de vista ya están implementados y probados en Chromium headless (#157/#158), pero ningún laboratorio de hardware físico ni verificación manual con lector de pantalla real se ha ejecutado todavía; ambos issues lo documentan como fuera de su propio alcance. | `docs/crew/PERFORMANCE.md`, `tests/e2e/crew-accessibility-157.spec.ts`. |
| 8 | Matriz E2E de dos modos (Caricatura y Crew) sin regresión del modo legado, documentada y reproducible en CI. | **Cumplido en el alcance de software disponible hoy; pendiente la certificación G1 completa del Epic.** 16 archivos de E2E de Crew (`tests/e2e/crew-*.spec.ts`) cubren cámara, catálogo, aislamiento de salas, SSE/REPLAY, accesibilidad, regreso exacto a Caricatura y límites de import verificados por análisis estático. | `tests/crew-mode-boundary-166.test.mjs`, `tests/lib/crewModeContract166.test.tsx`, `tests/e2e/crew-domain.spec.ts`. |
| 9 | Plan de respaldo y reversión (rollback) documentado y probado para volver a Caricatura sin pérdida de datos si una migración real fallara. | **Pendiente.** Hoy existe el interruptor de modo (`cartoon`/`crew`) sin pérdida de estado al alternar (#166), pero no existe ningún documento dedicado de plan de rollback para un escenario de migración real o de retiro parcial; ese documento tendría que escribirse como parte de la propia decisión de retiro, no antes. | `docs/adr/ADR-002-crew-two-mode-architecture.md` (contrato de los dos modos, base de cualquier rollback futuro). |
| 10 | Aprobación explícita y por escrito del propietario, en un issue nuevo dedicado exclusivamente a la decisión de retiro, posterior a que las filas 1-9 de esta tabla estén en "Cumplido". | **Pendiente por definición: no ha ocurrido y no puede ocurrir en este documento.** Ninguna fila anterior está completa todavía, y aunque lo estuvieran, esta tabla por sí sola no sustituye esa aprobación. | [Epic #114](https://github.com/jmmana/Agent-Viewer/issues/114), sección 8: "Caricatura NO se elimina automáticamente. El retiro sería una decisión posterior y explícita, respaldada por paridad verificable." |

### Regla de cierre de este gate

Ninguna fila de la tabla anterior se marca "Cumplido" por redactar texto o por abrir un PR: se marca solo cuando la funcionalidad referenciada esté implementada, probada y verificada en el renderer Crew independiente, siguiendo exactamente el mismo estándar que ya aplica `docs/crew/IMPLEMENTATION-STATUS.md` a cada issue del Epic. Cuando todas las filas de la 1 a la 9 estén en "Cumplido", eso habilita (no reemplaza) la fila 10: abrir un issue nuevo, dirigido exclusivamente al propietario, para decidir si el retiro de Caricatura procede. Hasta entonces, Caricatura sigue intacta, sin cambios de código motivados por esta consolidación.

## 3. Fuera de alcance de #161 (a propósito)

- Cualquier cambio de código en `src/crew/`, `src/engine/` o `src/components/OfficeCanvas.tsx`. Esta entrega es exclusivamente documental.
- Producir, promover o aprobar arte nuevo del banco de PR #43. Ninguna pieza cambia de `prototype` a `approved` en este documento.
- Ejecutar, proponer formalmente o programar el retiro real de Caricatura. Eso requiere el issue nuevo dedicado que describe la fila 10 del gate.
- Fusionar PR #43 a `main`, en cualquier forma, parcial o total.

## 4. Próximos pasos automáticos

- Mantener `ASSET-MIGRATION-PR43.md` e `ISSUE-172-ACCEPTANCE.md` como fuente única de verdad del banco; este documento no los duplica.
- Cada issue de arte/animación (#118-127, #130-154) que cierre debe actualizar la fila correspondiente de la tabla del gate en este documento, citando su propia evidencia verificable, igual que ya hace `IMPLEMENTATION-STATUS.md` por issue.
- `tests/crew-pr43-consolidation-161.test.mjs` debe seguir en verde en cada PR que toque este documento o las rutas que cita como evidencia; si una ruta se elimina o se renombra, el PR que la elimina es responsable de actualizar esta tabla en el mismo cambio.

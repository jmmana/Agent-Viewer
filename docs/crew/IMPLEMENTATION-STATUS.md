# Estado de implementación de Crew

Actualizado: 2026-10-08 (America/Bogota).
Último issue trabajado: #156, cámara Crew por oficina. Epic: #114.

## Base verificada

- Repositorio: jmmana/Agent-Viewer. Main observado: `637b1f5`.
- Rama: `feat/crew-camera-gestures-156`, basada en `3e18d2a` de #177.
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
- Implementación: commit `75f2da7`, [PR #182](https://github.com/jmmana/Agent-Viewer/pull/182), abierto sobre #177. [CI](https://github.com/jmmana/Agent-Viewer/actions/runs/37868817792) en curso al registrar el PR.

## Estado real de los 55 issues

Todos siguen abiertos. Registrar una sala o aprobar CI no satisface los criterios finales.

| Issue | Estado verificable |
| --- | --- |
| [#115](https://github.com/jmmana/Agent-Viewer/issues/115) | Auditoría parcial de 53 assets en #176 y revisión local; migración pendiente. |
| [#116](https://github.com/jmmana/Agent-Viewer/issues/116) | Guías históricas en #43 requieren adaptación al ADR Crew. |
| [#117](https://github.com/jmmana/Agent-Viewer/issues/117) | Pipeline histórico en #162 sobre #43; adaptación independiente pendiente. |
| [#118](https://github.com/jmmana/Agent-Viewer/issues/118) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
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
| [#155](https://github.com/jmmana/Agent-Viewer/issues/155) | Adaptador de presencia de solo lectura en #177; bridge completo pendiente. |
| [#156](https://github.com/jmmana/Agent-Viewer/issues/156) | Gestos táctiles, rueda y teclado implementados en esta rama; foco y pan acotado pendientes. |
| [#157](https://github.com/jmmana/Agent-Viewer/issues/157) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#158](https://github.com/jmmana/Agent-Viewer/issues/158) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#159](https://github.com/jmmana/Agent-Viewer/issues/159) | Dos E2E de cámara y regresión básica de cambio de modo en esta rama. |
| [#160](https://github.com/jmmana/Agent-Viewer/issues/160) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#161](https://github.com/jmmana/Agent-Viewer/issues/161) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
| [#166](https://github.com/jmmana/Agent-Viewer/issues/166) | Contrato y selector en PR #175, borrador. |
| [#167](https://github.com/jmmana/Agent-Viewer/issues/167) | Renderer independiente en PR #177, borrador. |
| [#168](https://github.com/jmmana/Agent-Viewer/issues/168) | Registro y selector de 11 salas prototipo en #177. |
| [#169](https://github.com/jmmana/Agent-Viewer/issues/169) | Aislamiento y fit prototipo en #177; QA completa pendiente. |
| [#170](https://github.com/jmmana/Agent-Viewer/issues/170) | 11 layouts locales prototipo en #177; faltan colisiones y arte final. |
| [#171](https://github.com/jmmana/Agent-Viewer/issues/171) | Cámara por sala en #175; modo y sala seleccionada aún no persisten. |
| [#172](https://github.com/jmmana/Agent-Viewer/issues/172) | Inventario fusionado (#176); recursos sin migrar al runtime. |
| [#173](https://github.com/jmmana/Agent-Viewer/issues/173) | ADR fusionado (#174); validación gráfica final pendiente. |

## Próximos tres pasos

1. #171: persistencia versionada de modo y sala seleccionada, restauración y datos corruptos.
2. #156: foco de escritorio/agente y pan acotado al viewport; arte multivista sigue pendiente.
3. #159: ampliar LIVE/DEMO/REPLAY, limpieza de lifecycle y matriz responsive antes del gate G1.

## Riesgos y decisiones

- Este PR está apilado sobre #177 y #175; integrar en orden y reconciliar con main antes de release.
- G1 no está aprobado. No iniciar despliegue masivo de arte ni cerrar oficinas por geometría provisional.
- Mantener cuatro vistas discretas Canvas2D; no son órbita 3D.
- Personajes y muebles finales no están dibujados en estas escenas. No alterar ni fusionar automáticamente #43.

# Aceptación funcional de #171

Fecha: 2026-10-09. Alcance: preferencias, navegación y controles de Crew.
Referencia: [issue #171](https://github.com/jmmana/Agent-Viewer/issues/171),
[ADR-001](../adr/ADR-001-crew-camera.md) y [API embebida](EMBEDDED-API.md).
Esta aceptación no certifica arte final ni el hito G1 del Epic #114.

## Contrato y almacenamiento

El estado de presentación se separa del store de eventos. Las claves existentes
`agent-viewer-crew-navigation-v1` y `agent-viewer-crew-camera-v1` conservan
modo/sala y cámaras locales por ID. `agent-viewer-crew-preferences-v1` contiene
`{ version: 1, reducedMotion: boolean }`. No exige migrar destructivamente
preferencias previas: una clave ausente usa defaults; JSON corrupto, versión
futura y tipo desconocido recuperan valores seguros. Fallos de almacenamiento
mantienen navegación y preferencias en memoria. El reset elimina las cámaras
Crew, vuelve a Dirección, conserva Crew abierto y restablece su preferencia de
movimiento. Ajustar afecta solo la vista de la sala actual.

Sonido usa los controles existentes de TopBar/Settings y
`agent-viewer-sound-preference-v1`, `{ version: 1, enabled: boolean }`, default
true compatible con la aplicación anterior. El reset Crew no modifica esta
preferencia global compartida. No se añade audio inexistente a AgentOffice.
Movimiento reducido propio se combina con el del sistema mediante OR; false
nunca anula accesibilidad del dispositivo. El cambio cancela el temporizador y
la carga del clip; conserva la pose estática.

La API embebida mantiene preferencias por instancia o las delega al host con
props/callbacks, igual que sala y cámaras. No toca URL, localStorage ni eventos.
Anterior/siguiente usa orden del catálogo, se desactiva en extremos y comparte
el callback del selector. Cada sala sigue conservando su propia cámara.

## Matriz verificable

| Requisito | Evidencia |
| --- | --- |
| Crew/Development persisten al recargar | `crew-navigation.spec.ts`: modo, sala y cámara tras reload y Caricatura |
| Zoom/vista independientes por oficina | `crew-camera.spec.ts`, `crew-navigation.spec.ts`, `crew-preferences-171.spec.ts`: ida/vuelta preserva zoom 120% y back |
| Cámara y controles Caricatura conservados | `crew-camera.spec.ts`: comparación exacta del PNG antes/después en LIVE vacío bajo reduced-motion; `cartoonCameraMemory.test.tsx` |
| Enlace inválido seguro y opción volver | `crew-navigation.spec.ts`: aviso, Dirección, canvas visible, selector y botón Cartoon disponibles |
| Reset de vista/preferencias sin alterar agentes | `crew-navigation.spec.ts`: reset conserva consumo; `crew-domain.spec.ts`: agentes/SSE/log; nuevo test LIVE vacío y reset preferencias |
| Persistencia segura, versión/default/reset | `crewPreferences171.test.tsx`, `crewNavigation.test.ts`, `crewCamera.test.ts`: entradas inválidas y almacenamiento bloqueado |
| Sonido/reduced-motion útiles | nuevo E2E recarga mute; nuevo unit cancela timer activo con override; tests de blink existentes mantienen prioridad del sistema |
| Anterior/siguiente, fit, foco agente/escritorio | nuevo E2E límites e ida/vuelta; `crew-camera.spec.ts` foco/fit/pan/pinch; `crewPresence.test.ts` foco de agentes y IDs ajenos |
| API embebida controlada y aislada | `crewEmbedded.test.tsx`, `crewPreferences171.test.tsx`, `crew-embedded.spec.ts` |
| Vacío, sala eliminada, cámara extrema, cambio durante actividad | navigation/camera/domain E2E y unit events/presence: estado compartido sin mutación, recuperación de bounds, cero agentes LIVE |
| Recursos fallidos | `crew-sprites.spec.ts`, tests sprites: marcador conservado y aviso accesible |

## Validación y límites

La evidencia de esta entrega usa Chrome emulado y datos sintéticos. No equivale
a prueba en dispositivos físicos. El test SSE existente intercepta red del
cliente; no certifica reconexión contra servidor real. Los cambios de sala y
modo conservan snapshots/eventos, pero no implementan animaciones de llamadas
o reuniones, que corresponden a sus issues. La cámara Caricatura se compara en
un escenario determinista; la suite de dominio verifica agentes activos y
consumo por separado. El arte actual conserva su clasificación prototipo.

La aprobación de diseño y CI es responsabilidad de revisión del PR; ejecutar
pruebas localmente no sustituye esa aprobación. La evidencia visual de controles
se registra desde la nueva prueba Playwright, sin importar lógica de #43.

## Resultado local de esta entrega

- `npm run lint`, compilaciones app/lib/CLI y `npm run check:package`: aprobados.
- Primer `npm test`: 472 Node aprobados, uno omitido; 601 Vitest aprobados.
- Validación final: 472 Node aprobados y uno omitido sin concurrencia; 602 Vitest aprobados, incluidos seis tests exclusivos #171. Una repetición concurrente tuvo dos fallos de umbral de tiempo (hook 537 ms y store 6,35 s) que aprobaron al ejecutarlos sin concurrencia.
- Playwright Chrome, puerto aislado 3171: 18/18 aprobados en la repetición completa.
  El primer pase tuvo un fallo intermitente existente en la comprobación de
  drawImage de sprites; la repetición aislada y completa aprobaron.
- `npm audit --omit=dev`: cero vulnerabilidades. Python: 12 tests aprobados;
  wheel construido, instalado e importado en venv aislado.
- Docker local: el daemon no respondió a la consulta de versión; los builds de
  ambas imágenes quedan para CI.

[Captura de preferencias](evidence/preferences-171/preferences.png) y
[MP4 de navegación, reload, mute y reset](evidence/preferences-171/runtime.mp4),
obtenidos del mismo E2E aprobado. Captura revisada: Development/back/120%, mute,
checkbox activo, navegación visible y cero agentes LIVE.

Reproducción del E2E específico con puerto aislado: crear un config temporal que
importe `playwright.config.ts`, cambie `use.baseURL` a `http://127.0.0.1:3171` y
`webServer` a `npx vite --port 3171 --host 127.0.0.1`, con
`reuseExistingServer: false`; ejecutar
`PLAYWRIGHT_CHANNEL=chrome npx playwright test --config <config-temporal> tests/e2e/crew-preferences-171.spec.ts`.

Los cinco criterios bloqueantes tienen implementación y pruebas trazables.
Se recomienda aceptar el alcance funcional de #171 tras revisión de contrato y
CI verde; el cierre no implica aprobar arte final ni G1.

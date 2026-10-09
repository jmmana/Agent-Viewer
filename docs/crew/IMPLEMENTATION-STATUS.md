# Estado de implementación de Crew

Actualizado: 2026-10-09 (America/Bogota).
Último issue trabajado: #118/#117/#172, piloto estático del CEO y carga de recursos. Epic: #114.

## Resumen de la ejecución

El [PR #194](https://github.com/jmmana/Agent-Viewer/pull/194) integra los incrementos #175, #177, #182, #183, #185, #186, #187, #189, #190 y #191 en main, conservando sus commits. Merge `a867cd2`, 2026-10-09. Se reconciliaron los cambios recientes de CLI, contratos, almacenamiento y CI; los tres conflictos de configuración conservaron ambos conjuntos de comprobaciones. #175 quedó fusionado automáticamente y los PR apilados restantes se cerraron por integración, tras verificar que sus commits son ancestros de main. #43 no se fusionó. Ningún issue funcional se cerró.

[CI previo al merge](https://github.com/jmmana/Agent-Viewer/actions/runs/37923447700) y [CI posterior en main](https://github.com/jmmana/Agent-Viewer/actions/runs/37923645463) aprobados, incluidos navegador, CLI Node 22.13, Python y contenedores. Validación local del conjunto integrado: 275 Node aprobados y uno omitido, 522 Vitest, 12 E2E y 12 Python; tipos, compilaciones app/lib/CLI y paquete aprobados.

El incremento posterior incorpora el piloto estático del CEO en cuatro vistas, con carga bajo demanda, conservación de marcadores ante fallos y pruebas de limpieza. Validación local: 276 Node aprobados y uno omitido, 528 Vitest y 14 E2E. Compilaciones app/lib/CLI, typecheck, integridad del banco y paquete aprobados. Los PNG originales no se modificaron. Evidencia en [ceo-118](evidence/ceo-118/).

Crew sigue en Beta. G1 no está certificado: faltan arte final de salas, animaciones verdaderas, integración completa de acciones, rendimiento y dispositivos físicos. Los apartados históricos siguientes registran cada incremento con los pendientes que existían entonces.

## Base verificada

- Repositorio: jmmana/Agent-Viewer. Main observado: `637b1f5`.
- Rama actual: `feat/crew-character-assets-118`, basada en la integración `f2cfc11` de #194.
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

## Estado real de los 55 issues

Todos siguen abiertos. Registrar una sala o aprobar CI no satisface los criterios finales.

| Issue | Estado verificable |
| --- | --- |
| [#115](https://github.com/jmmana/Agent-Viewer/issues/115) | 53 originales recuperados con hashes y procedencia; banco aislado, revisión artística e integración pendientes. |
| [#116](https://github.com/jmmana/Agent-Viewer/issues/116) | Guías históricas en #43 requieren adaptación al ADR Crew. |
| [#117](https://github.com/jmmana/Agent-Viewer/issues/117) | Pipeline histórico en #162 sobre #43; adaptación independiente pendiente. |
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
| [#158](https://github.com/jmmana/Agent-Viewer/issues/158) | Pendiente en Crew independiente; antecedentes de arte o showroom no equivalen a entrega. |
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

## Próximos tres pasos

1. #118/#117: completar contrato de orientación y clips animados a partir del piloto estático, sin contar poses como animaciones.
2. #155/#156: ampliar el bridge de tareas y reuniones sobre las posiciones locales y el foco ya implementados; arte multivista pendiente.
3. #159: servidor SSE real, reproducción temporal, rendimiento y dispositivos físicos antes de aprobar G1.

## Continuación #118: contrato de orientación

`crewRelativeView(facing, view)` define que `facing` (opcional en el marcador de presencia, por defecto `front`) es la vista de cámara desde la que se ve el frente del actor; la pose mostrada es la relativa a la cámara actual. Dato local de la sala, sin escritura en dominio. El renderer dibuja la pose solo en marcadores cuya vista resuelta coincide con la imagen cargada; el resto conserva el marcador numerado (una única vista cargada a la vez). Pruebas unitarias en `tests/lib/crewSprites.test.ts`. `facing` ya tiene origen provisional: `crewFacingToward` orienta al actor hacia el escritorio/pantalla más cercano de su sala. Pendiente: orientación por movimiento/acciones/sillas, clips animados (la carga de varias vistas simultáneas ya está resuelta: `useCrewSprites` carga cada vista distinta requerida y el renderer elige la pose por actor). #118 sigue abierto. Siguiente sugerida: #118/#128 clips animados reales, o #155 bridge de tareas/reuniones.

## Riesgos y decisiones

- Este PR está apilado sobre #177 y #175; integrar en orden y reconciliar con main antes de release.
- G1 no está aprobado. No iniciar despliegue masivo de arte ni cerrar oficinas por geometría provisional.
- Mantener cuatro vistas discretas Canvas2D; no son órbita 3D.
- Personajes y muebles finales no están dibujados en estas escenas. No alterar ni fusionar automáticamente #43.

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

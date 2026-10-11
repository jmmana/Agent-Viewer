# Pipeline de fotogramas Crew

Issue [#117](https://github.com/jmmana/Agent-Viewer/issues/117). El pipeline pertenece exclusivamente al renderer Crew independiente. No importa el canvas de Caricatura ni las herramientas históricas de clips.

El piloto CEO tiene cuatro atlas originales de caminar, cada uno con ocho fases ilustradas a 8 FPS. Conservan el estado `prototype`: la inspección visual aceptó identidad y extremidades cambiantes para este piloto de ingeniería, sin aprobar arte final ni el alcance más amplio del CEO en #118. Las trayectorias y locomoción corresponden a #129. La reproducción lee `Agent.isWalking` y su orientación del snapshot existente; nunca modifica posición, eventos, tareas ni consumo.

## Origen, catálogo y runtime

| Capa | Ruta y propósito |
| --- | --- |
| Referencias | `assets/crew/references/ceo-approved-concept.png` y las cuatro poses originales del banco, preservadas byte por byte. |
| Origen y estudio descartado | `assets/crew/origins/walk-117/`: prompts exactos e izquierda v1 descartada. Su segunda fila repetía medio ciclo; nunca se importa en runtime. |
| Atlas originales seleccionados | `assets/crew/clips/ceo-walk-*.png`: salidas de `image_gen` integrado copiadas sin editar píxeles, reescalar, reflejar ni rotar. |
| Catálogo versionado | `assets/crew/clips/manifest.v1.json`: metadatos canónicos y rectángulos medidos. |
| Runtime | `crewWalkRegistry.ts`, `useCrewWalk.ts`, `crewSpriteLayer.ts` y los orquestadores existentes `CrewStage`/`renderCrewRoom`. |

El manifiesto registra `schemaVersion`, id `<rol>.<clip>.<orientación>.v<versión>`, rol, variante, clip, orientación, dimensiones raster, resolución lógica, FPS, anclaje lógico normalizado, loop, anclajes en píxeles/duraciones/orden/hash por cuadro, licencia, commit fuente, referencia, archivo/hash del prompt exacto, hash del atlas y notas de revisión visual del prototipo. Exige exactamente un clip activo por orientación. El registro piloto admite únicamente `ceo/default/walk`.

| Orientación | PNG original | Tamaño real | Rectángulos fuente |
| --- | --- | --- | --- |
| front | `ceo-walk-front-v1.png` | 1512×1040 | Cuatro columnas, cuadros de 492 px de alto, filas y=0/492. |
| right | `ceo-walk-right-v1.png` | 1513×1040 | Cuatro columnas enteras medidas, cuadros de 510 px de alto, filas y=0/510. |
| back | `ceo-walk-back-v1.png` | 1513×1039 | Cuatro columnas enteras medidas, cuadros de 510 px de alto, filas y=0/510. |
| left | `ceo-walk-left-v2.png` | 1470×1070 | Cuatro columnas enteras medidas, cuadros de 527 px de alto, filas y=0/527. |

Estos atlas **no son** poses PNG de 256×352. Conservan el contrato de presentación lógica 256×352 y anclaje (0.5, 0.9375); cada cuadro fuente tiene anclajes explícitos medidos en píxeles y la altura de presentación sigue en 76 unidades. Se inspeccionó el alfa decodificado para separar filas sin capturar cabello de la siguiente. El anclaje x centra la silueta y el y es el píxel opaco más bajo del zapato más uno. No se procesan imágenes ni se traslada una pose para simular movimiento. Se conserva el movimiento de extremidades; diferencias de escala/anchura y pequeños residuos alfa siguen como límites conocidos del prototipo.

## Importación segura e integridad

```sh
node scripts/crew-clip-assets.mjs check
node scripts/crew-clip-assets.mjs import /ruta/al/candidato.json
```

Importar fuerza `prototype`, valida antes de escribir, rechaza sustituir un catálogo existente diferente y escribe de forma atómica. Una importación idéntica es idempotente. La aprobación exige revisión visual humana separada y cambio explícito del catálogo; el importador no puede otorgarla. El inspector decodifica PNG solo para validar, nunca para editar. Verifica RGBA, píxeles realmente transparentes/opacos por cuadro, hashes de atlas/cuadro/prompt, rectángulos, duración, anclajes, cuatro orientaciones únicas y duplicados de id/archivo/contenido. Las rutas permanecen dentro del repositorio incluso mediante enlaces simbólicos. Los hashes prueban integridad, no calidad de movimiento: se inspeccionaron por separado los dibujos y la evidencia runtime.

## Comportamiento runtime

Solo los marcadores ilustrados CEO de la sala seleccionada que reportan `isWalking` solicitan atlas. La correspondencia existente entre orientación y cámara elige arte real sin reflejarlo. Cada orientación requerida se carga una vez por escena montada. Elegir cámara precarga únicamente su módulo; el original estático sigue visible hasta cargar el PNG. Un atlas ausente o con dimensiones erróneas conserva el sprite original y muestra aviso EN/ES.

Un único reloj de presentación muestrea duraciones explícitas de 125 ms. Movimiento reducido, incluida la preferencia del sistema, conserva la pose original y evita descargar atlas. Una pestaña oculta detiene el reloj y regresa al cuadro 0. Cambiar sala, orientación, modo o desmontar cancela callbacks de imagen y timers; callbacks tardíos no pueden poblar la escena actual. No hay caché global de imágenes ni cambios del store. El tránsito reportado se reproduce **en el mismo punto Crew que ya asigna el snapshot**, hasta que #129 provea trayectorias reales; no se afirma validación contra deslizamiento de pies.

## Evidencia reproducible

`tests/e2e/fixtures/crew-walk.html` monta el `CrewStage` real con entrada sintética congelada y rotulado DEMO visible y localizado. Es un fixture de prueba, no un renderer alternativo ni control de producción. `tests/e2e/crew-walk.spec.ts` verifica ocho rectángulos fuente en cuatro cámaras, entrada conservada, filtro de rol/sala, fallback, móvil en español, zoom 3 y movimiento reducido. La suite completa conserva las pruebas de Caricatura y alternancia de modo.

Las vistas PNG y el [MP4 runtime](evidence/walk-117/runtime.mp4) viven en `evidence/walk-117/`. Cámara y orientación del actor son distintas: cámara front/right/back/left proyecta el facing SE a sprite front/left/back/right. Los nombres de captura indican la orientación del **sprite**. Grabación en Chrome con puerto aislado 3117, sin servicios externos ni datos reales. Los props siguen como bloques geométricos prototipo; la evidencia no certifica G1, otros roles, salas finales ni acciones adicionales de #118.

## Validación final

Validado sobre main `5560b2c`: 1.051 Node aprobados (uno omitido), 740 Vitest, 29 Python y 29 E2E Chrome aprobados. Typecheck, auditoría de producción, builds app/lib/CLI, paquete y reconciliación aprobados. Se ejecutó la suite completa una vez; se corrigió un valor de enum del fixture y solo se repitió typecheck antes de ejecutar el navegador. Pasaron las suites existentes de SSE, replay de logs y regresión Caricatura; la nueva prueba pura del renderer conserva eventos y consumo de snapshots completos y de prefijos de replay. No se usan datos privados de proveedores.

## Extensión de escritorio (Refs #118)

`actions.v1.json` registra 16 clips prototype / 64 cuadros originales para girar, sentarse, levantarse y teclear. Conserva el patrón de metadatos de caminar sin cambiar su importador específico. Tamaños reales, prompts y giro v1 descartado en `assets/crew/origins/desktop-118/README.md`. `referenceHeight` por cuadro conserva la escala corporal al sentarse; la altura real del recorte es independiente. `crew-desktop-assets.test.mjs` verifica hashes de origen/cuadros/prompts, dimensiones y alfa. Ver [evidencia y límites](evidence/desktop-118/README.es.md).

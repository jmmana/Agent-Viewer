# Contrato de estilo visual Crew

Issue: [#116 [CREW][VIS-02] Estilo visual Crew y contrato de arte independiente](https://github.com/jmmana/Agent-Viewer/issues/116), hijo del [Epic #114](https://github.com/jmmana/Agent-Viewer/issues/114).

Este es un entregable únicamente documental. Formaliza reglas que ya existen en el código, en la referencia aprobada y en el [ADR-001](../adr/ADR-001-crew-camera.md), para que un futuro ilustrador o ingeniero tenga un solo contrato al cual apuntar en lugar de hacer ingeniería inversa del piloto del CEO. No agrega, edita ni regenera arte, no cambia ningún módulo de runtime y no promueve ningún asset a `approved`.

## 1. Alcance y autoridad

- Rige únicamente el modo **Crew**: un estilo chibi ilustrado original "Office Beans". No es pixel art ni una reskin del look de siluetas de Among Us. `Caricatura` (`src/engine/canvasRenderer.ts`, `src/components/OfficeCanvas.tsx`) queda intacto y conserva su propio estilo visual, sin relación con este; el [ADR-002](../adr/ADR-002-crew-two-mode-architecture.md) es el contrato formal de esa independencia (Caricatura y Crew nunca se importan entre sí, un cambio de modo nunca recrea el store de dominio).
- Orden de autoridad cuando los documentos difieren: **el código y el manifiesto de assets** (`assets/crew/asset-manifest.json`, `src/crew/*.ts`) son la fuente de verdad; el [ADR-001](../adr/ADR-001-crew-camera.md) es la decisión de arquitectura de cámara/proyección; el [ADR-002](../adr/ADR-002-crew-two-mode-architecture.md) es el contrato de independencia de los dos modos; [FACING.md](FACING.md) es la matemática de orientación canónica; este documento es la capa de estilo encima y debe corregirse en el mismo PR si alguna vez se aparta de lo realmente implementado.
- Todo lo aquí descrito asume la regla de independencia del ADR-001: Crew nunca importa el renderer legado, nunca reutiliza `renderFurnitureItem`, `GRID_ROWS`/`GRID_COLS` ni `getOfficeRenderedBounds`, y una sala muestra solo su propia escena, nunca la planta completa.

## 2. Material de referencia

La única referencia de estilo aprobada es [`assets/crew/references/ceo-approved-concept.png`](../../assets/crew/references/ceo-approved-concept.png) (PNG de 1536x1024, estado `reference` en el manifiesto, licencia MIT, nunca modificada). Es una lámina de concepto con estos paneles, que este contrato trata como el origen de cada regla siguiente:

- **Personaje base**: turnaround frente, perfil izquierdo, espalda, perfil derecho.
- **Expresiones faciales**: una cuadrícula de 2x5 (neutral, concentrado, feliz, pensando, preocupado, confundido, explicando, aprobando, bloqueado/estresado, hablando).
- **Animación de caminar**: cuatro direcciones (abajo/arriba/izquierda/derecha en la convención 2D propia de la lámina), 8 cuadros cada una.
- **Poses de trabajo e interacción**: sentarse, trabajar en laptop, levantarse, hablar, pensar, llamada telefónica, en reunión, presentar, tomar café, celebrar.
- **Props y accesorios**: laptop, smartphone, taza de café con marca, clipboard y lápiz, lentes, gafete con cordón etiquetado "CEO".
- **Paleta de colores (CEO)**: seis muestras con nombre y código hexadecimal (sección 6).
- **Iconos y efectos**: burbuja de diálogo, nube de pensamiento, foco, check, alerta, teléfono, wifi, gráfico de barras, calendario, documento.
- Panel de **escala y referencia**.

**Discrepancia conocida, registrada en lugar de ocultada:** el propio panel "Escala y referencia" de la lámina marca al personaje en 48 px de alto por 32 px de ancho. El runtime realmente construido y probado usa números distintos y más grandes (sección 4). Este contrato trata los valores **implementados** como la autoridad, porque son los que `asset-manifest.json`, `crewSprites.ts` y las pruebas automatizadas realmente exigen hoy; la nota de 48x32 de la lámina se conserva solo como contexto histórico de la imagen de concepto, no como objetivo para arte nuevo.

## 3. Estados del ciclo de vida de un asset

El issue pide un ciclo de vida `reference | vector-study | prototype | approved`. Dos de esos cuatro ya existen como valores exigidos por el manifiesto; los otros dos se nombran y acotan aquí para que el próximo issue que los toque no tenga que inventar el vocabulario.

| Estado | Significado | Dónde vive hoy | Exigencia |
| --- | --- | --- | --- |
| `reference` | Fuente de identidad/estilo. Exactamente una por línea de personaje, salvo que una decisión futura a nivel ADR la reemplace (como un id nuevo, por ejemplo `reference.ceo.v2`; nunca una edición in situ). | `assets/crew/references/ceo-approved-concept.png`, entrada `reference` del manifiesto. | `scripts/crew-assets.mjs` exige `status: 'reference'` y el hash exacto registrado. |
| `vector-study` | Los 1.584 estudios técnicos SVG migrados del PR #43 (`assets/characters/*/vector-study/**`). Explícitamente **excluidos** de `asset-manifest.json` y del runtime Crew. Útiles solo como material de estudio de trazo/proporción para ilustradores; nunca citables como prueba de una pose o animación aprobada. | Fuera de `assets/crew/`, documentado en [ASSET-MIGRATION-PR43.md](ASSET-MIGRATION-PR43.md). | No existe ni debe existir entrada de manifiesto para ellos; se mantienen fuera deliberadamente. |
| `prototype` | Estado actual de los 53 assets del banco más la referencia (54/54). Seguro para conectar en ingeniería (carga de sprites, proyección de cámara, cableado del controlador de animación) pero nunca presentado como arte final sin el rotulado de "no definitivo" que exige el ADR-001 para los placeholders. | `assets/crew/asset-manifest.json`, cada entrada de asset. | `npm run crew:assets:check` (hash, dimensiones, id/archivo duplicado, licencia, sin clasificación inventada de animación o perspectiva). |
| `approved` | Aún no alcanzable. Un asset se vuelve `approved` solo después de (a) una revisión visual contra las reglas de silueta/paleta/proporción de este contrato para su rol, (b) un PR que cambia su `status` en el manifiesto con el revisor anotado en [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), y (c) para personajes, las cuatro orientaciones presentes y aprobando la verificación de identidad de la sección 5. | No se usa en ningún lugar todavía. | `scripts/crew-assets.mjs` hoy **rechaza** cualquier `status` que no sea `reference` o `prototype` ("La migración no aprueba arte automáticamente"). Habilitar el primer asset `approved` real requiere un cambio de seguimiento a ese validador; queda fuera del alcance de este documento (sección 13). |

## 4. Lienzo de personaje, proporciones y el estándar chibi

Los 11 prototipos de personaje del banco (`ceo` con 6 poses, `analyst`, `developer`, `finance`, `planner`, `reviewer` con 1 pose cada uno) ya coinciden en el mismo lienzo, confirmado directamente desde `asset-manifest.json`:

- **Raster de runtime**: exactamente **256x352 px**, PNG RGBA con canal alfa real (`scripts/crew-assets.mjs` rechaza cualquier tipo de color PNG fuera de `{4, 6}`, es decir, el canal alfa es obligatorio).
- **Tamaño lógico**: 64x88 unidades de mundo, registrado en el manifiesto como metadato histórico de tamaño. Según [`assets/crew/README.md`](../../assets/crew/README.md), este valor **no** define colisiones ni escala en el modelo espacial Crew (eso lo gobierna `CREW_PROP_SIZE` en `crewSpatial.ts`); trátese como contabilidad heredada, no como contrato espacial.
- **Anclaje**: exactamente **(0.5, 0.9375)**, normalizado al lienzo, es decir, los pies del personaje se ubican al 50% del ancho y 93.75% del alto. Es un valor real y exigido en runtime (`CREW_CEO_SPRITE.anchor` en `src/crew/crewSprites.ts`), no una sugerencia.
- **Este contrato vuelve obligatorios tanto el lienzo 256x352 como el anclaje (0.5, 0.9375) para toda futura pose u orientación de personaje**, independientemente de la salvedad de metadato histórico anterior, que solo exime el *tamaño lógico* para fines espaciales, no la convención de lienzo raster ni de anclaje. `validateCrewAssets` en `scripts/crew-assets.mjs` ahora exige esto para toda entrada `kind: 'character'` (`CREW_CHARACTER_CANVAS`, `CREW_CHARACTER_ANCHOR`), cubierto por `tests/crew-assets.test.mjs`.
- **Altura de presentación en una sala**: 76 unidades locales de escena (`CREW_CEO_SPRITE.displayHeight`). Es una constante del renderer que el ilustrador no controla; el arte solo necesita ser correcto en el lienzo 256x352, sin importar la escala en escena que la cámara aplique después.
- **Proporciones chibi** (confirmadas visualmente contra la referencia aprobada): cabeza sobredimensionada respecto al cuerpo, rasgos redondeados, lentes negros gruesos y redondeados en todos los roles, cuerpo completo visible con piernas y zapatos (nunca un torso flotante ni un cuerpo tipo cápsula), vestuario corporativo acorde al rol, y gafete con cordón a la altura del pecho.
- **Prohibido simular una orientación faltante.** El ADR-001 nombra esto explícitamente como opción prohibida ("Opción D", rechazada) y el issue lo repite: nunca estirar, deformar ni voltear horizontalmente el arte de una orientación para suplir otra. Una vista faltante se entrega como un asset nuevo, genuinamente dibujado, o se mantiene como placeholder rotulado "no disponible" (`artAvailability: 'missing'` en `CrewViewDefinition`). `crewSpriteView()` ya solo resuelve una vista cuando existe arte real para ella; nunca deriva una orientación a partir de otra.

## 5. Las cuatro orientaciones de cámara y la consistencia de identidad

- Las orientaciones son **front / right / back / left** (`CrewView`), cada una un cuadro ilustrado completo y separado, nunca una rotación de una sola pieza de arte (ADR-001, sección 2).
- La correspondencia dominio-cámara pertenece a [FACING.md](FACING.md) y está implementada en `crewSprites.ts` (`SPRITE_FACINGS`); este contrato la referencia en lugar de duplicarla, con un recordatorio para ilustradores: la etiqueta de cámara identifica el **ángulo de vista de la sala**, no la orientación propia del personaje, así que el arte `front` de un personaje puede aparecer en pantalla bajo una cámara `left` o `right` según hacia dónde esté realmente orientado ese personaje en la escena.
- **Regla de identidad.** El mismo personaje debe seguir siendo reconocible a simple vista en las cuatro orientaciones: misma silueta de cabello, mismos lentes, mismo color y corte de saco, mismo gafete, mismo prop en mano (si lo hay), mismo tono de piel. Esto es justo lo que protegen la evidencia de cuatro vistas del CEO (`docs/crew/evidence/ceo-118/*.png`) y la prueba dedicada del manifiesto (`tests/crew-assets.test.mjs`, "el piloto CEO conserva dimensiones y anclaje..."). Un PR que agregue una orientación nueva para cualquier rol debe incluir una ficha comparativa equivalente.
- Hoy solo `ceo` tiene las cuatro orientaciones (más dos poses extra, `phone-front` y `work-front`); los otros cinco roles (`analyst`, `developer`, `finance`, `planner`, `reviewer`) tienen un único prototipo `idle-front` cada uno. Completar sus orientaciones restantes debe seguir esta misma regla de identidad y este mismo contrato de lienzo antes de que cualquiera de ellos pueda considerarse para `approved`.

## 6. Los seis roles: fichas de silueta y paleta

Los seis roles comparten un sistema (cabeza chibi, lentes, gafete con cordón, código de vestimenta corporativo) y difieren en exactamente dos variables deliberadas: **color/corte de la prenda exterior** y **el prop en mano**, que también es la señal funcional de qué hace ese rol. Los valores de paleta de los cinco roles distintos del CEO se miden automáticamente desde los PNG prototipo `idle-front` existentes mediante [`scripts/crew-palette-measure.mjs`](../../scripts/crew-palette-measure.mjs) (`npm run crew:palette:measure`): cuantización de color de 16 niveles, alfa ≥ 200, excluyendo explícitamente por tono y luminosidad el cabello/trazo (familia marrón rojizo oscuro) y la piel clara, para que no se confundan con el color de la prenda del rol. [`tests/crew-palette-measure.test.mjs`](../../tests/crew-palette-measure.test.mjs) bloquea la muestra de cada rol contra el PNG real del banco, para que la tabla de abajo no pueda desalinearse en silencio del arte que describe. Siguen describiendo lo que ya está dibujado, no una especificación ratificada por un director de arte (ver sección 13): una revisión anterior de esta tabla traía las mismas cinco muestras como aproximaciones a ojo (con prefijo `~`) sin ningún script detrás; esta revisión las reemplaza por los valores exactos, reproducibles y verificados por prueba, sin promover ninguno más allá de "sin ratificar". La paleta del CEO, en cambio, es la **redactada en la propia lámina de referencia aprobada** y debe tratarse como definitiva.

| Rol | Estado hoy | Prenda exterior (señal de silueta) | Muestra medida/redactada | Prop en mano | Notas |
| --- | --- | --- | --- | --- | --- |
| `ceo` | `prototype`, 4 orientaciones + 2 poses extra | Saco cruzado sencillo azul marino, corbata | `#1E3A84` (Azul oscuro), acento `#2563EB` (Azul corporativo), redactado | Teléfono / laptop; gafete "CEO" | La proporción de torso más larga de los seis; único rol con lámina de concepto completa |
| `analyst` | `prototype`, solo `idle-front` | Saco verde azulado, corbata | `#085868` (medido, verificado por script, sin ratificar) | Tablet mostrando un gráfico de barras | El tono de cabello más claro de los seis en el prototipo actual |
| `developer` | `prototype`, solo `idle-front` | Chamarra casual azul brillante con puños celestes de contraste | `#1848C8` (medido, verificado por script, sin ratificar) | Laptop bajo el brazo | Único rol con chamarra casual en vez de saco o chaleco |
| `finance` | `prototype`, solo `idle-front` | Chaleco verde oscuro/bosque sobre camisa y corbata, sin saco exterior | `#283838` (medido, verificado por script, sin ratificar) | Calculadora / terminal POS en mano | Botones visibles en el chaleco; sin solapas |
| `planner` | `prototype`, solo `idle-front` | Saco índigo/morado | `#482888` (medido, verificado por script, sin ratificar) | Clipboard con lista de verificación | Corbata de azul más claro que el saco |
| `reviewer` | `prototype`, solo `idle-front` | Saco terracota/óxido, abierto sobre camisa blanca y corbata negra | `#C85838` (medido, verificado por script, sin ratificar) | Clipboard | El tono más cálido de los seis |

Valores compartidos entre roles:

- **Tono de piel**: `#FAD7C4` (muestra "Piel" redactada en la referencia del CEO). Los prototipos de los otros cinco roles miden en la misma familia cálida (cubos cuantizados `#F0C090`/`#F0D0A0`); adoptar `#FAD7C4` como objetivo canónico.
- **Cabello/trazo**: una familia de marrón oscuro (rango medido `#201010`-`#402020`) en todos los roles del arte actual.
- **Lentes**: gruesos, redondeados, negros, en todos los roles sin excepción. Es la señal de silueta compartida más fuerte que identifica "esto es un personaje Crew" a simple vista.
- **Gafete**: un gafete con cordón de rectángulo redondeado con una letra/ícono, centrado a la altura del pecho, presente en todos los roles.
- **Neutros** de la referencia del CEO, usables como neutros compartidos de interfaz/fondo cuando se necesiten: `#374151` (Gris grafito), `#F8FAFC` (Blanco roto).

## 7. Props, mobiliario, electrónicos y efectos: convención de nombres

- Disposición de archivos: `assets/crew/bank/{characters,furniture,electronics,effects}/<slug>.{png,svg}`.
- Patrón de id en el manifiesto: `character.<rol>.<clip>.<orientación>` para personajes (por ejemplo `character.ceo.idle.front`); `<tipo>.<slug>` para todo lo demás (por ejemplo `furniture.desk-executive`, `electronics.dual-monitor`, `effect.wifi`).
- Según la matriz de assets por cámara del ADR-001, se espera que mobiliario y electrónicos eventualmente tengan variantes por orientación (front/right/back/left) que comparten un mismo hitbox/anclaje. Mientras ese arte no exista, `renderCrewRoom.ts` dibuja cajas geométricas de relleno (el mapa `color` dentro de ese archivo: rellenos de escritorio/silla/planta/pantalla). **Esos colores de relleno no son arte final** y nunca deben capturarse en pantalla ni citarse en un documento de aceptación como mobiliario aprobado.
- Las pantallas (monitor, laptop, TV) nunca renderizan texto ni personajes reflejados. Desde una orientación donde la cara de la pantalla no es visible, se muestra solo la carcasa/espalda/perfil físico (ADR-001, fila "Pantallas y televisor").
- Los efectos (`alert`, `blocked`, `call`, `check`, `sync`, `terminal`, `thought`, `tool`, `wifi`) se renderizan solo en respuesta a un evento real `LIVE` o a una escena explícitamente rotulada `DEMO`; nunca son ambientación decorativa (ADR-001, sección 5, punto 7, y la propia regla del issue sobre salas vacías).

## 8. Contrato de animación y clips

El parpadeo `ceo.blink.front.v1` (`src/crew/crewAnimation.ts`) es la implementación de referencia original que esta sección formaliza. Los cuatro clips prototipo de caminar ahora usan el catálogo versionado y los rectángulos medidos descritos en [FRAME-PIPELINE.es.md](FRAME-PIPELINE.es.md); sus atlas generados tienen dimensiones distintas del lienzo de pose estática 256x352, conservando su contrato lógico de presentación:

- **Patrón de id de clip**: `<rol>.<nombre-del-clip>.<orientación>.v<versión>`.
- Un clip es un **atlas** (PNG/WebP RGBA) con un arreglo explícito de `frames`. Cada cuadro tiene un rectángulo en píxeles (`x, y, width, height`), un `anchor` por cuadro medido en **espacio de píxeles del atlas** (no el anclaje normalizado 0..1 usado para una pose estática) sobre los píxeles opacos del pie de ese cuadro específico (esto compensa el desvío de generación entre celdas sin tocar los píxeles), y una `durationMs`. Todo esto lo valida `validateCrewClip()`: rectángulos enteros dentro de los límites del atlas, duración positiva, anclaje dentro de los límites propios del cuadro.
- Una pose estática (`frames: 1, fps: 0, loop: false` en el manifiesto) nunca es un "clip" aprobado. Un clip cuenta como genuinamente animado solo cuando tiene 2 o más cuadros visualmente distintos. Para un ciclo de caminar en particular, el criterio de aceptación del issue exige **al menos 6 cuadros distintos por dirección**; la propia lámina de referencia aprobada ya dibuja **8 cuadros por dirección de caminar**, y este contrato adopta 8 como el objetivo real, no 6, para que el arte futuro no retroceda por debajo de lo que ya fue diseñado y aprobado.
- `loop: true` es para gestos de reposo/ambiente (parpadeo, respiración); `loop: false` es para reacciones de una sola vez (celebrar, contestar una llamada) que deben volver a un clip de reposo después. `crewClipSample()` ya codifica esto: un clip sin loop, pasado su último cuadro, retorna `{ index: último, nextInMs: null }` y no programa nada más.
- **Movimiento reducido**: todo clip debe tener un cuadro de "reposo" presentable en el índice 0, porque `crewClipSample(..., reducedMotion=true)` siempre retorna `{ index: 0, nextInMs: null }`; ese es el único cuadro que verá un usuario con movimiento reducido, o uno cuyo atlas falló al cargar.
- **Pestaña oculta**: el controlador de parpadeo existente pausa su reloj mientras la pestaña está oculta y reanuda desde el cuadro "ojos abiertos". Por la misma razón, el cuadro 0 de cualquier clip nuevo debe ser un punto de reanudación seguro.
- Un estudio de pose, un único cuadro ilustrado o un estudio vectorial nunca son prueba de que un clip está "animado" (esto repite la redacción explícita ya usada en `assets/crew/README.md` e `IMPLEMENTATION-STATUS.md`; este contrato no la relaja).

## 9. Orden de capas y proyección de cámara (solo referencia, la posee el código)

Esta sección no es política nueva; reafirma la sección 3 del ADR-001 y `renderCrewRoom.ts` para que un ilustrador sepa qué garantiza ya el motor alrededor de su arte:

- Orden de dibujo: suelo → paredes traseras → mobiliario trasero → agentes/props ordenados por profundidad local `(x + y)` → mobiliario delantero → luces/partículas → HUD. La pared frontal se recorta para permitir ver el interior; no es arte faltante, es una decisión de render deliberada.
- La proyección es `oblique-2_5d` (el `projection` de `CrewViewDefinition` del ADR-001), una proyección pseudoisométrica fija, discreta y por vista, no una cámara 3D libre. El ilustrador solo necesita saber qué borde de la silueta mira hacia la "cámara" en cada orientación; el orden de composición lo posee el motor, no los archivos de arte.

## 10. Accesibilidad y rango de zoom

- El zoom de cámara está limitado a **[0.5, 3]** en código (`crewCamera.ts`: `zoomCrewCameraAt`, `validateCrewCamera`). El arte debe leerse con claridad en ambos extremos: sin detalle fino que desaparezca por debajo de 0.5x, sin pixelado o banding visible que resulte molesto a 3x cuando un PNG de 256x352 se escala hacia arriba en el canvas. Previsualizar el arte nuevo en ambos extremos antes de marcarlo `approved`.
- Los controles de cámara por teclado y táctiles quedan fuera del alcance de este documento (los posee #156/#171); este contrato solo rige el arte, no el manejo de entradas.

## 11. Licencia y bitácora de procedencia

- Todo asset del banco ya lleva `license`, `provenance`, `sourceCommit` y `sha256`, exigidos por `validateCrewAssets()`. Un asset nuevo aportado por un ilustrador debe llevar los mismos campos (con `sourceCommit`/`provenance` describiendo su origen real nuevo en lugar del commit del PR #43) para que el validador existente siga funcionando sin romper el esquema.
- Los assets `reference.*` nunca se modifican in situ. Un concepto revisado se entrega como un id nuevo (por ejemplo `reference.ceo.v2`), para que las capturas de evidencia antiguas y los PR que citaron la referencia anterior sigan siendo válidos y auditables.

## 12. Lo que este documento explícitamente no hace

- No agrega, edita ni regenera ningún asset PNG, SVG ni WebP.
- No cambia los datos de `asset-manifest.json`, ni `crewSprites.ts`, ni `crewAnimation.ts`, ni `renderCrewRoom.ts`, ni ningún otro módulo de runtime más allá del refuerzo del validador descrito en la sección 4 (que codifica un invariante ya verdadero, no cambia el arte ni los datos actuales).
- No promueve el `status` de ningún asset a `approved`.
- No bloquea ni redefine el trabajo fundacional CREW-001..008; existe para que los ilustradores tengan un contrato al cual apuntar antes de que se entregue la primera orientación o clip fuera del CEO, en lugar de hacer ingeniería inversa manual del piloto del CEO.

## 13. Pendientes abiertos (explícitamente fuera de alcance aquí)

- Habilitar una transición de estado a `approved` en `scripts/crew-assets.mjs` cuando un issue futuro realmente promueva un asset real.
- Una clasificación formal `vector-study` en el manifiesto, si los 1.584 SVG del PR #43 alguna vez se catalogan en lugar de mantenerse deliberadamente excluidos como hoy.
- Ratificación por un director de arte de las paletas de los cinco roles distintos del CEO; las muestras de la sección 6 hoy están verificadas por script sobre el arte prototipo existente (ver `scripts/crew-palette-measure.mjs`), no son una decisión redactada como la del CEO. Que la medición sea exacta y reproducible no equivale a ratificarla: eso sigue requiriendo una decisión humana de dirección de arte que este documento no toma.
- Arte por orientación de mobiliario y electrónicos, para reemplazar las cajas geométricas de relleno que dibuja hoy `renderCrewRoom.ts`.

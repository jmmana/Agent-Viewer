# QA manual de lector de pantalla para #157

Issue [#157](https://github.com/jmmana/Agent-Viewer/issues/157) (VIS-43), parte
del Epic [#114](https://github.com/jmmana/Agent-Viewer/issues/114). Este
documento es la checklist reproducible para la única pieza de #157 que ningún
agente de código puede ejecutar de verdad: verificar con un lector de pantalla
físico (VoiceOver o NVDA) que los controles de accesibilidad de Crew, ya
implementados y cubiertos por pruebas automatizadas, se comportan bien para
quien realmente depende de un lector de pantalla.

Ver [docs/crew/IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), sección
"Continuación #157: accesibilidad, controles y audio (wiring)", para el
registro canónico de qué está implementado y por qué #157 sigue abierto.

## Qué NO es este documento

- **No certifica que la verificación ya ocurrió.** Al momento de escribir esto
  nadie ha ejecutado esta checklist con un lector de pantalla real en
  hardware físico: la ejecución manual sigue **pendiente**. Nada en este
  archivo debe leerse como una verificación ya hecha.
- **No reemplaza** la cobertura automatizada ya existente en
  [`tests/e2e/crew-accessibility-157.spec.ts`](../../tests/e2e/crew-accessibility-157.spec.ts):
  esa prueba confirma que los 23 escenarios de navegación por teclado (foco,
  Tab, Espacio, Enter, flechas) funcionan sin mouse. Esta checklist confirma
  algo distinto y que Playwright no puede medir: qué anuncia de verdad un
  lector de pantalla real al enfocar cada control.
- **No inventa controles.** Cada id, atributo y texto citado abajo existe hoy
  en `src/crew/CrewStage.tsx`, `src/crew/CrewRoomSelector.tsx`,
  `src/crew/crewPreferences.ts` y `src/crew/crewContrast.ts`, y la prueba
  [`tests/crew-manual-qa-157.test.mjs`](../../tests/crew-manual-qa-157.test.mjs)
  falla si alguno deja de existir.

## Quién puede ejecutar esto

Cualquier persona con acceso a uno de estos pares de software/hardware. No
hace falta repetir la checklist completa con los dos: con uno solo que pase
(o falle, documentando el fallo) ya es evidencia real.

| Lector de pantalla | Sistema operativo | Navegador recomendado |
| --- | --- | --- |
| VoiceOver | macOS | Safari |
| VoiceOver | iOS/iPadOS | Safari |
| NVDA | Windows | Firefox o Chrome |

## Preparación

1. Levanta la app en modo Crew con una sala con agentes, por ejemplo:
   `/?mode=live&visualMode=crew&crewRoom=development` (la misma URL que usa
   la prueba E2E automatizada).
2. Antes de empezar, pulsa el botón **"Reset Crew preferences"** /
   **"Restablecer Crew"** para partir de las preferencias por defecto:
   `muted: true` (silenciado, cero audio por defecto), `volume: 0.6`,
   `highContrast: false`, `subtitles: true`, `hudSize: 'standard'`,
   `accessibilityPreset: 'none'`, `reducedMotion: false`.
3. Activa el lector de pantalla (VoiceOver: Cmd+F5 en macOS; NVDA: Ctrl+Alt+N
   en Windows) y navega **solo con teclado** (Tab, Shift+Tab, flechas,
   Espacio, Enter). No uses el mouse ni el trackpad durante la checklist.

## Qué significa "aprobado" y "fallo" en general

- **Aprobado**: el lector de pantalla anuncia un nombre accesible claro para
  el control (no "botón" o "casilla" a secas, sino el texto real: "Alto
  contraste", "High contrast", etc.), anuncia su rol (casilla, botón, control
  deslizante, lista desplegable) y su estado actual (marcado/no marcado,
  valor, expandido/colapsado), y el foco visual coincide con lo que el lector
  de pantalla dice estar anunciando.
- **Fallo**: el lector de pantalla no anuncia nada al enfocar el control, lee
  un nombre genérico sin relación con la etiqueta visible, omite el estado
  (por ejemplo no dice si una casilla está marcada), o el foco salta a un
  elemento distinto del que el lector de pantalla describe.

Cada paso de abajo añade el criterio específico cuando aplica, además de este
criterio general.

## Paso a paso

### 1. Región principal de Crew

Al cargar la página, el lector de pantalla debe poder navegar a una región
con nombre "Crew mode: independent office" / "Modo Crew: oficina
independiente" (`<section aria-label>`).

- **Aprobado**: el lector de pantalla anuncia esa región por su nombre al
  navegar por regiones/landmarks (VoiceOver: VO+U, rotor "Landmarks"; NVDA:
  tecla D para "regions").
- **Fallo**: la región no aparece en el rotor/lista de landmarks, o se anuncia
  sin nombre.

### 2. Búsqueda y selección de oficina

Controles reales: `#crew-room-search` (input `type="search"`, etiqueta
"Search offices" / "Buscar oficina", con `aria-describedby="crew-room-results"`)
y `#crew-room` (`<select>`, etiqueta "Office" / "Oficina").

- Enfoca `#crew-room-search` y escribe una letra, por ejemplo "d".
- **Aprobado**: el lector de pantalla anuncia la etiqueta "Search offices" al
  enfocar el campo, y al escribir anuncia el contenido actualizado de
  `#crew-room-results` (el `<span aria-live="polite">` describedby, por
  ejemplo "2 offices found" / "2 oficinas encontradas") sin que el foco se
  mueva del campo de búsqueda.
- **Fallo**: el lector de pantalla no anuncia los resultados al escribir, o
  el `aria-describedby` no se lee nunca (algunas combinaciones de NVDA +
  Firefox antiguas no leen `aria-describedby` en `input[type=search]`;
  documenta la versión exacta si esto ocurre, es un hallazgo real, no un
  error de la checklist).
- Enfoca `#crew-room` y cambia de oficina con flechas arriba/abajo.
- **Aprobado**: el lector de pantalla anuncia cada opción (incluye el
  conteo de agentes, por ejemplo "Development · 2/6") al navegar con flechas,
  y al confirmar, la región de subtítulos (paso 4) anuncia el cambio de sala.
- **Fallo**: el `<select>` cambia de sala visualmente pero el lector de
  pantalla no anuncia la opción nueva.

### 3. Cámara, zoom y enfoque de objetos

Controles reales: `#crew-view` (`<select>`, etiqueta "Camera" / "Cámara",
opciones Front/Right/Back/Left), los botones con `aria-label="Zoom out"` /
`"Zoom in"` ("Alejar"/"Acercar"), el botón "Fit room" / "Ajustar", y
`#crew-focus` (`<select>`, etiqueta "Focus" / "Enfocar", opciones "Choose
object", "Desk N", "Monitor N").

- **Aprobado**: cada botón de zoom anuncia su `aria-label` completo ("Zoom
  out"/"Zoom in"), no solo el carácter visual "−"/"+"; el `<select>` de
  cámara anuncia las cuatro orientaciones por su nombre (no solo "Front"
  seguido de valores sin traducir); cambiar de cámara dispara un anuncio
  "Camera: Front" / "Cámara: Frente" en la región de subtítulos (paso 4).
- **Fallo**: los botones de zoom se anuncian como "−"/"+" sin contexto, o
  cambiar de cámara no produce ningún anuncio en la región de subtítulos.

### 4. Región de subtítulos (anuncios de sala y cámara)

Control real: el contenedor `<div aria-live="polite" data-crew-captions="true">`
(id `#crew-captions` vía `data-testid`). Este contenedor existe siempre en el
DOM, con o sin el checkbox "Subtitles" activo; lo único que cambia es si se ve
en pantalla (si `subtitles` está desactivado, queda oculto visualmente pero
sigue siendo accesible al lector de pantalla).

Textos reales que push-ea esta región (ver `pushCaption` en `CrewStage.tsx`):

- Cambio de sala: `"Office: {nombre}"` / `"Sala: {nombre}"`.
- Cambio de cámara: `"Camera: {orientación}"` / `"Cámara: {orientación}"`.
- Estado de audio: `"Room audio: playing."` / `"Audio de la sala:
  reproduciendo."`, `"Room audio: paused."` / `"Audio de la sala: en
  pausa."`, o el aviso de bloqueo del navegador.

Pasos:

1. Con el checkbox "Subtitles" (`#crew-subtitles`) **activado**, cambia de
   sala. Confirma que el texto aparece visible en pantalla y que el lector de
   pantalla lo anuncia sin que el foco se mueva hacia esa región (anuncio de
   región `aria-live`, no de foco).
2. Desactiva el checkbox "Subtitles" y vuelve a cambiar de sala.
   - **Aprobado**: el texto deja de verse en pantalla (confirmar con las
     herramientas de desarrollador: el contenedor pasa a tener estilos de
     "solo lectores de pantalla", no `display: none` ni `visibility:
     hidden`), pero el lector de pantalla **sigue anunciando** el cambio de
     sala igual que antes. Esto es intencional: alguien que no necesita
     subtítulos visibles en pantalla pero sí depende del lector de pantalla
     no debe perder la información.
   - **Fallo**: al desactivar "Subtitles", el lector de pantalla deja de
     anunciar los cambios de sala/cámara (señal de que el contenido se quitó
     del DOM en vez de solo ocultarse visualmente).

### 5. Casilla "Reduce motion" (barra principal)

Control real: `#crew-reduced-motion`, etiqueta "Reduce motion" / "Reducir
movimiento". Vive en la barra principal, no dentro del panel colapsable.

- **Aprobado**: el lector de pantalla anuncia "Reduce motion, checkbox, not
  checked" (o equivalente en NVDA) al enfocar, y tras pulsar Espacio anuncia
  "checked".
- **Fallo**: se anuncia como un elemento sin rol de casilla, o el estado
  marcado/no marcado no se lee.

### 6. Abrir el panel "Crew accessibility and audio" (`<details>`/`<summary>`)

El resto de controles de accesibilidad (alto contraste, subtítulos, audio,
tamaño de HUD, preset) viven colapsados por defecto dentro de un
`<details>`/`<summary>` nativo, con el texto "Crew accessibility and audio" /
"Accesibilidad y audio de Crew". Esto es deliberado (ver comentario en
`CrewStage.tsx`): evita empujar el canvas fuera del viewport en móvil.

1. Navega con Tab hasta el `<summary>` y pulsa Enter (o Espacio).
- **Aprobado**: el lector de pantalla anuncia el `<summary>` con un rol de
  grupo/divulgación y su estado ("collapsed"/"colapsado" antes de abrir,
  "expanded"/"expandido" después), igual que ya confirma
  `crew-accessibility-157.spec.ts` de forma automatizada para el flujo sin
  lector de pantalla. Tras abrir, el foco puede quedarse en el `<summary>`
  (comportamiento nativo del navegador) y Tab avanza al primer control
  interior.
- **Fallo**: el lector de pantalla no distingue el `<summary>` de un texto
  normal, no anuncia el cambio de estado expandido/colapsado, o el contenido
  interior no es alcanzable con Tab tras abrir.

### 7. Alto contraste

Control real: `#crew-high-contrast`, etiqueta "High contrast" / "Alto
contraste". Al activarse, el canvas cambia a la paleta
`CREW_HIGH_CONTRAST_THEME` de `src/crew/crewContrast.ts`: fondo `#000000`,
texto `#ffffff`, acento `#ffd400`, anillo de foco `#00e5ff`. La relación de
contraste de estos colores ya está calculada y probada automáticamente en
`tests/lib/crewContrast.test.ts` contra los umbrales WCAG AA/AAA; esta
checklist **no** recalcula esa aritmética, verifica la experiencia real.

1. Activa la casilla y confirma que el lector de pantalla anuncia "checked".
2. Con la vista (no solo el lector de pantalla), confirma que el canvas
   cambia a fondo negro con texto blanco y acentos amarillo/cian, y que el
   contraste se percibe nítido a simple vista (sin forzar zoom ni lupa del
   sistema).
3. Si tienes acceso a una herramienta de aumento de contraste del sistema
   operativo (zoom + alto contraste de Windows/macOS), actívala junto con
   NVDA/VoiceOver y confirma que la paleta de Crew no choca con la paleta del
   sistema (por ejemplo, que no queda texto negro sobre fondo negro).
- **Aprobado**: la casilla se anuncia correctamente y el canvas cambia de
  paleta de forma visible, legible y sin elementos que desaparezcan.
- **Fallo**: la casilla se anuncia pero el canvas no cambia de paleta, o
  cambia mal (por ejemplo algún texto queda ilegible sobre el nuevo fondo).

### 8. Silenciar audio y volumen

Controles reales: `#crew-muted` (checkbox, "Mute Crew audio" / "Silenciar
audio de Crew", marcado por defecto: cero audio por defecto) y `#crew-volume`
(`<input type="range">`, etiqueta "Crew volume" / "Volumen de Crew",
deshabilitado mientras `#crew-muted` está marcado, con
`aria-valuetext="{N}%"`).

**Limitación conocida y honesta**: Crew todavía no tiene motor de audio
propio con sonido real en la mayoría de salas; solo la sala "Lounge" /
"Sala de descanso" tiene una pista (ver
`docs/crew/AUDIO_LICENSES.md`). Mute/volumen son wiring funcional de
verdad (cambian el estado real, habilitan/deshabilitan el control de
volumen), pero no hay nada audible que escuchar fuera de esa sala.

1. Confirma que `#crew-muted` empieza marcado y `#crew-volume` empieza
   deshabilitado; el lector de pantalla debe anunciar el control de volumen
   como "dimmed"/"deshabilitado" o equivalente.
2. Desmarca `#crew-muted` con Espacio. Confirma que el lector de pantalla
   anuncia el cambio a "not checked" y que `#crew-volume` pasa a estar
   habilitado (el lector de pantalla ya no debe anunciarlo como
   deshabilitado).
3. Enfoca `#crew-volume` y mueve el valor con flecha derecha/izquierda.
   - **Aprobado**: el lector de pantalla anuncia el porcentaje actualizado
     (por ejemplo "65%") en cada paso, usando el `aria-valuetext` real, no
     solo un número crudo del rango 0-1.
   - **Fallo**: el lector de pantalla anuncia un valor distinto al que
     aparece en pantalla, o no anuncia nada al mover el control.

### 9. Reproducir/pausar audio de la sala

Control real: botón `data-testid="crew-audio-toggle"` con `aria-pressed`
(texto "▶ Play room audio" / "⏸ Pause room audio", "▶ Reproducir audio de la
sala" / "⏸ Pausar audio de la sala"), deshabilitado si el navegador no admite
Web Audio o si la sala actual no tiene pista propia. Junto a él, un texto con
`role="status"` (`data-testid="crew-audio-status"`) que informa el estado
real: "Audio unavailable in this browser.", "Blocked by the browser. Press
Play again.", "This office has no music of its own.", "Playing." o "Paused.
Never plays without pressing Play."

1. En una sala sin música (todas excepto "Lounge"), confirma que el botón
   está deshabilitado y que el `role="status"` anuncia "This office has no
   music of its own." / "Esta oficina no tiene música propia."
2. Cambia a la sala "Lounge" / "Sala de descanso" y confirma que el botón se
   habilita.
3. Pulsa el botón con Enter/Espacio.
   - **Aprobado**: el lector de pantalla anuncia el cambio de estado
     `aria-pressed` (de "not pressed" a "pressed"), el texto del botón cambia
     a "⏸ Pause room audio" y el `role="status"` vecino anuncia "Playing."
     sin que el foco se mueva del botón.
   - **Fallo**: el lector de pantalla no anuncia el cambio de `aria-pressed`,
     o el `role="status"` no se anuncia automáticamente (tendrías que
     navegar manualmente hasta él para enterarte).
4. Si el navegador bloquea el audio (política de autoplay), confirma que el
   `role="status"` cambia a "Blocked by the browser. Press Play again." y que
   el lector de pantalla lo anuncia sin interacción adicional.

### 10. Tamaño de controles (HUD) y preset de accesibilidad

Controles reales: `#crew-hud-size` (`<select>`, etiqueta "Controls size" /
"Tamaño de controles", opciones Compact/Standard/Large) y
`#crew-a11y-preset` (`<select>`, etiqueta "Accessibility preset" / "Preset de
accesibilidad", opciones None/Screen reader/Low vision, que llaman a
`applyCrewAccessibilityPreset()` en `crewPreferences.ts`).

- Selecciona "Large" en `#crew-hud-size`.
  - **Aprobado**: el lector de pantalla anuncia la opción elegida; a nivel
    visual, los textos y controles del HUD crecen (escala `CREW_HUD_SCALE`).
- Selecciona "Screen reader" en `#crew-a11y-preset`.
  - **Aprobado**: el lector de pantalla anuncia la opción elegida, y al
    volver a enfocar `#crew-reduced-motion`, `#crew-subtitles` y
    `#crew-hud-size`, cada uno anuncia el nuevo estado resultante
    (`reducedMotion: true`, `subtitles: true`, `hudSize: 'large'`) sin
    necesidad de tocarlos manualmente uno por uno.
- Selecciona "Low vision" en `#crew-a11y-preset`.
  - **Aprobado**: al volver a enfocar `#crew-high-contrast`,
    `#crew-hud-size` y `#crew-subtitles`, cada uno anuncia el nuevo estado
    (`highContrast: true`, `hudSize: 'large'`, `subtitles: true`).
- **Fallo** (ambos presets): algún control relevante no refleja el cambio
  cuando el lector de pantalla lo revisita, o el `<select>` del preset no
  anuncia la opción elegida.

### 11. Lista de agentes de la sala

Región real: `<div aria-live="polite">` con el texto "Agents in this room: N"
/ "Agentes en esta oficina: N" y, por cada agente visible, un botón con
`aria-label="Focus {nombre}"` / `"Enfocar a {nombre}"`.

- **Aprobado**: el lector de pantalla anuncia el conteo total de agentes al
  cambiar de sala (sin necesidad de navegar manualmente hasta la región), y
  cada botón de agente se anuncia con su nombre completo vía `aria-label`
  (no solo el texto visible truncado).
- **Fallo**: el lector de pantalla no anuncia el cambio de conteo al cambiar
  de sala, o los botones de agente se anuncian sin nombre.

### 12. Canvas de la oficina (pan/zoom por teclado)

Control real: `<canvas>` con `aria-label="Office view: {sala}"` / `"Vista de
oficina: {sala}"`, `tabIndex={0}`. Con el foco en el canvas: flechas para
desplazar la cámara (32px por pulsación), `+`/`=` para acercar, `-` para
alejar, `Home` para restablecer la cámara a los valores por defecto.

- **Aprobado**: el lector de pantalla anuncia el nombre de la oficina actual
  al enfocar el canvas con Tab; las teclas de flecha/zoom/Home mueven la
  cámara sin que el lector de pantalla capture esas teclas para su propia
  navegación (en NVDA esto puede requerir activar el "modo foco"; documenta
  si hiciste falta activarlo manualmente, es un hallazgo real sobre la
  usabilidad, no un fallo del control en sí).
- **Fallo**: el lector de pantalla no anuncia ningún nombre para el canvas, o
  intercepta las teclas de flecha de forma que nunca llegan a mover la
  cámara real.

## Resultado y siguiente paso

Al terminar, registra en un comentario del issue
[#157](https://github.com/jmmana/Agent-Viewer/issues/157):

- Combinación exacta usada (lector de pantalla + versión + navegador +
  sistema operativo).
- Por cada paso de esta checklist: aprobado, fallo (con detalle) o no
  aplicable.
- Si todos los pasos quedan aprobados en al menos una combinación real,
  #157 puede cerrarse citando este comentario como evidencia. Hasta
  entonces, cualquier PR relacionado debe seguir usando "Refs #157", nunca
  "Closes #157": el issue pide explícitamente verificación real, no un
  reporte de otra sesión de agente ni un prototipo.

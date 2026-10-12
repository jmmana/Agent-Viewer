# Modo Crew: la guía pública

Issue [#160](https://github.com/jmmana/Agent-Viewer/issues/160), parte del Epic
[#114](https://github.com/jmmana/Agent-Viewer/issues/114). Este es el punto de
entrada para quien evalúa Agent Viewer sin haber leído la documentación de
implementación: qué son hoy realmente Caricatura y Crew, cómo cambiar entre
ambos, qué hace cada control y, igual de importante, qué sigue siendo un
marcador de posición. Cada afirmación de abajo se verifica contra el código y
las pruebas reales, no contra una intención de diseño; ver
[docs/crew/IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) para el
registro completo issue por issue que esta guía resume.

Crew está en **Beta**. No reemplaza al modo Caricatura, y el modo Caricatura
no se toca por nada de lo descrito aquí.

## 1. Dos modos, lado a lado

Agent Viewer ofrece dos modos visuales independientes sobre los mismos datos
de eventos/agentes/consumo. Cambiar de modo nunca reinicia agentes, tareas,
costes ni el estado de replay; solo cambia qué renderer dibuja la oficina.

| | Caricatura (legado) | Crew (nuevo, Beta) |
| --- | --- | --- |
| Propósito | La vista de oficina original, sin cambios | Un renderer nuevo de oficinas ilustradas, construido de forma independiente |
| Renderer | Su propio canvas y cámara, intactos por el trabajo de Crew | Su propio canvas/cámara/ciclo de vida de escena, nunca importa el dibujo de Caricatura |
| Salas | Una sola planta de oficina compartida | 11 salas separadas, seleccionadas una a la vez |
| Cámara | Pan/zoom legado | Zoom, pan, 4 orientaciones (frente/derecha/espalda/izquierda) y reset, por sala |
| Personajes | Sprites legados | 6 arquetipos cosméticos con un editor de personalización; la mayor parte del arte sigue siendo marcador de posición (ver sección 4) |
| Estado | Estable, producción | Beta: algunas salas y roles tienen arte ilustrado real y animación probada, la mayoría todavía no |

El cambio de modo se hace desde el botón de la barra de herramientas en la app
de demostración: dice **Caricatura** (**Cartoon** en inglés) y **Crew · Beta**.
Esa etiqueta exacta es la que el script de reproducción automática de la
sección 6 hace clic, así que si alguna vez ves una etiqueta distinta en la app
en ejecución, esta guía (y el script) están desactualizados, y eso mismo
merece reportarse como error.

## 2. Elegir una oficina, y por qué solo ves una

Crew modela cada oficina como una escena independiente: Dirección/CEO,
Planificación, Desarrollo, Investigación/Analyst, QA/Reviewer, Finanzas,
Reuniones, Infraestructura/War Room, Descanso/Café y Recepción. El selector
de sala (`#crew-room` en el DOM, issue
[#168](https://github.com/jmmana/Agent-Viewer/issues/168)) es un desplegable
buscable y operable por teclado. Elegir una sala monta **solo esa sala**: sus
propias paredes, piso, mobiliario y agentes. Ninguna otra sala renderiza sus
sprites, y ninguna otra sala pierde sus eventos mientras está oculta (issue
[#169](https://github.com/jmmana/Agent-Viewer/issues/169)); volver a ella la
restaura exactamente como estaba.

## 3. Cámara: zoom, pan, orientación y reset

Cada sala conserva su propio estado de cámara (issue
[#156](https://github.com/jmmana/Agent-Viewer/issues/156), decisión
registrada en [ADR-001](../adr/ADR-001-crew-camera.md)):

- **Orientación** (`#crew-view`): cuatro presets discretos 2.5D,
  frente/derecha/espalda/izquierda. No es una órbita 3D; el ADR descarta
  explícitamente simular perspectiva rotando el canvas 2D. Rotar la cámara
  alrededor de un personaje muestra su lado relativo correcto, no un sprite
  de frente espejado o congelado.
- **Zoom**: rueda del mouse, o pinch de dos dedos en pantallas táctiles,
  anclado al cursor o al punto medio del pinch, continuo entre
  aproximadamente 0.5x y 3x.
- **Pan**: arrastrar con clic en escritorio, arrastrar con un dedo en
  táctil, acotado para que no se pueda sacar la sala de la vista.
- **Teclado**: flechas para pan, `+`/`-` para zoom, `Home` para reset, todo
  sin salir del canvas.
- **Enfocar** (`#crew-focus`): salta la cámara a un mueble o agente
  específico dentro de la sala activa.
- **Ajustar**: el botón **Ajustar** (**Fit room** en inglés) restaura el
  encuadre inicial de la sala activa.

Cambiar de sala y volver a una sala más tarde restaura la preferencia de
cámara propia de esa sala; nunca se comparte entre salas ni se reinicia al
cambiar a Caricatura y volver (issue
[#171](https://github.com/jmmana/Agent-Viewer/issues/171)).

El selector **Ambiente** configura amanecer/día/atardecer/noche por sala, o sigue
la hora local con **Auto**. Ventanas, skyline, colores y brillo de monitores
geométricos cambian con la fase y la selección se conserva al recargar. Consulta
[Ambientes por sala](AMBIENCE.md) para horarios, persistencia y límites del arte
prototipo.

## 4. Personajes: qué es personalizable hoy, y qué sigue siendo marcador de posición

Crew define 6 arquetipos cosméticos (CEO, Planner, Developer, Analyst,
Reviewer, Finance) deliberadamente independientes del rol funcional del
agente; un agente puede "disfrazarse" de cualquiera de los seis sin que eso
cambie lo que realmente hace. El issue
[#127](https://github.com/jmmana/Agent-Viewer/issues/127) entrega un editor
de personalización funcional (categorías de cabello/piel/prenda/calzado/
accesorio, guardado por agente, vista previa de 4 cámaras) con pruebas
completas de ida y vuelta.

**Lo que honestamente no incluye todavía**: el editor opera sobre un catálogo
de entradas explícitas `placeholder`, no sobre arte ilustrado final. El arte
de apariencia real y con derechos despejados, junto con una biblioteca
modular de cabello/piel/ropa, son los issues
[#125](https://github.com/jmmana/Agent-Viewer/issues/125) y
[#126](https://github.com/jmmana/Agent-Viewer/issues/126), ambos totalmente
pendientes. Solo el rol CEO tiene hoy arte real de caminar/idle (calidad
prototipo, ver [FRAME-PIPELINE.md](FRAME-PIPELINE.md)); los otros cinco
roles solo tienen un sprite estático `idle-front`. Decidir la dirección de
arte final de todo esto es una decisión del propietario del producto, no algo
que esta guía ni un agente automatizado puedan resolver.

## 5. LIVE, DEMO y REPLAY

Crew puede mostrar una insignia que indica si lo que ves es `LIVE`, `DEMO` o
`REPLAY` (issue [#155](https://github.com/jmmana/Agent-Viewer/issues/155),
contrato documentado en [EMBEDDED-API.md](EMBEDDED-API.md)). Esto nunca se
infiere del flujo de eventos: la aplicación anfitriona decide y pasa el valor
de forma explícita, así que la integración es responsable de rotular con
honestidad los datos de demostración ficticios. Sin esa propiedad, Crew no
muestra ninguna insignia en vez de adivinar.

## 6. Evidencia reproducible: véelo correr tú mismo

Esta guía deliberadamente no incluye un video de marketing nuevo y pulido.
Ese tipo de producto final mezcla dirección de arte y decisiones de edición
que le corresponden al propietario del producto, no a una pasada de
documentación, y la compuerta "G1" del Epic #114 para eso sigue sin
certificarse (ver sección 9). Lo que esta guía sí entrega, y lo mínimo que
pide el issue #160, es una forma real y reproducible para que cualquiera
reproduzca el comportamiento actual de Crew desde un checkout limpio.

Corre el script de captura ya existente contra un servidor de desarrollo
local:

```sh
npm run dev
# en una segunda terminal
PLAYWRIGHT_CHANNEL=chrome npm run crew:capture
```

(Si no tienes el canal de Chrome del sistema, corre
`npx playwright install chromium` una vez y quita la variable
`PLAYWRIGHT_CHANNEL`.) Esto conduce un navegador Chromium real a través de:
abrir Crew, visitar las salas de CEO y Desarrollo, recorrer las cuatro
orientaciones de cámara en cada una, enfocar un escritorio, ajustar la sala,
volver a Caricatura y regresar a Crew tras recargar. Escribe una grabación de
pantalla real en `test-results/crew-demo/runtime.webm`. Conversión opcional a
MP4:

```sh
ffmpeg -i test-results/crew-demo/runtime.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart runtime-navigation.mp4
```

Es el mismo comando documentado en
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), y el script que corre
(`scripts/capture-crew-runtime.mjs`) está versionado, así que la grabación
siempre es reproducible, nunca una afirmación de una sola vez. Issues
anteriores ya produjeron y versionaron grabaciones y capturas de corridas
reales de este tipo de script; explóralas en [evidence/](evidence/), sobre
todo [evidence/camera-156/](evidence/camera-156/) (dos salas, las cuatro
orientaciones, enfoque de escritorio, pinch móvil, ida y vuelta a Caricatura)
y [evidence/engine-167/](evidence/engine-167/) (montaje/desmontaje de sala
vacía, escritorio y móvil). Nada de esto es una maqueta renderizada: cada PNG
y video bajo `evidence/` viene de una sesión real de navegador contra la app
real.

## 7. Recursos, licencias y pipeline

- [visual-style-contract.md](visual-style-contract.md): el contrato de arte
  (tamaño de canvas, anclajes, estados del ciclo de vida, fichas de
  silueta/paleta de los seis roles) que debe seguir cualquier arte futuro de
  Crew.
- [ASSET-MIGRATION-PR43.md](ASSET-MIGRATION-PR43.md): procedencia y destino
  de cada recurso rescatado de la rama de exploración anterior `#43`; nada de
  ahí se trata como arte final de Crew.
- [FRAME-PIPELINE.md](FRAME-PIPELINE.md) ([gemelo en español](FRAME-PIPELINE.es.md)):
  cómo se produjo, licenció y versionó el atlas de caminar del CEO, el único
  ejemplo de pipeline que existe de principio a fin hoy.
- [AUDIO_LICENSES.md](AUDIO_LICENSES.md): cada sonido que Crew puede
  reproducir se sintetiza en el navegador (sin muestra grabada, sin
  propiedad intelectual de terceros), el audio es opt-in y está silenciado
  por defecto.

## 8. Estado verificable, módulo por módulo

Esta guía no duplica la tabla completa por issue: se desactualizaría en
cuanto se fusione un nuevo PR. La fuente canónica y actualizada
continuamente es [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), que
enumera, para cada issue del Epic #114, si está cerrado o solo referenciado,
qué PR y corrida de CI lo verificaron y qué queda explícitamente fuera de
alcance. Al momento de esta guía, ese registro muestra: el motor, el
registro/selector de salas, la cámara, el layout espacial/colisiones, la
navegación, el controlador de animación y el contrato de dos modos tienen
código real y probado en main; la mayoría del mobiliario de las salas, cinco
de los seis roles de personaje, la coreografía de
reuniones y la compuerta de video de producción "G1" todavía no.

## 9. Qué queda explícitamente fuera de alcance aquí

Esta guía es documentación y una prueba de verificación de los comandos que
documenta, no funcionalidad de producto nueva. Lo siguiente queda, a
propósito, intacto por el issue #160:

- **Arte ilustrado final** para salas, mobiliario y los cinco roles que no
  son CEO. Eso es dirección de arte, una decisión del propietario del
  producto, no algo que una pasada de documentación pueda o deba fabricar.
- **Un video MP4/GIF de producción nuevo y pulido.** La sección 6 entrega en
  su lugar una captura real, guiada por script y reproducible; convertir eso
  en material de marketing es una decisión posterior y separada.
- **Certificación G1** del Epic #114. G1 exige arte final en todas las salas
  y roles más QA en dispositivos físicos; ninguno de los dos existe todavía,
  así que esta guía no afirma lo contrario.
- **Retirar el modo Caricatura.** Caricatura sigue siendo el modo por
  defecto y estable hasta una decisión separada y explícita que diga lo
  contrario.

## 10. Mantén esta guía honesta

Si cambias una etiqueta de botón, un id de control, el nombre de un script
de npm, o mueves un archivo de evidencia referenciado arriba, actualiza esta
guía y su gemelo en inglés, [README.md](README.md), en el mismo cambio.
[tests/docs-crew-public-guide.test.mjs](../../tests/docs-crew-public-guide.test.mjs)
corre en cada `npm run test:node` y falla la compilación si alguna de las
dos guías se desactualiza respecto a los comandos, archivos o ids de control
reales que documenta.

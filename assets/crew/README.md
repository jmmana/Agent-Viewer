# Banco de recursos Crew

Rescate selectivo de 53 originales y una referencia del CEO del [PR #43](https://github.com/jmmana/Agent-Viewer/pull/43), commit `355e9194bd83d8b741bc65d5b58a897d320ee584`. Los archivos conservan sus bytes originales. El manifiesto registra SHA-256, dimensiones, archivo fuente, licencia MIT y procedencia. Se aplica la licencia MIT del repositorio.

- 11 poses de personajes en PNG con canal alfa. Son imágenes de un fotograma, sin animación.
- 20 muebles, 13 electrónicos y 9 efectos en SVG. Sus cuatro perspectivas no están verificadas.
- Una referencia visual del CEO, clasificada como referencia y separada del banco de runtime.

Todos los recursos del banco siguen siendo `prototype`. Las vistas ausentes de personajes se indican explícitamente. El tamaño lógico y el anclaje son metadatos históricos; no definen colisiones ni escala en el modelo espacial Crew. No se importan los estudios vectoriales ni el renderer de #43.

## Comprobación y recuperación

`npm run crew:assets:check` valida el banco sin red ni acceso al historial Git. Se ejecuta también en CI.

`npm run crew:assets:import` recupera los originales desde el commit indicado, que debe existir en el clon local. Es idempotente y rechaza sobrescribir archivos con contenido diferente. No cambia de rama ni fusiona #43.

## Piloto de uso en Crew

El manifiesto usa `usage: source-bank`. El renderer Crew utiliza selectivamente las cuatro poses `character.ceo.idle.{front,right,back,left}` para agentes con rol boss presentes en la sala. El resto permanece fuera del runtime. Los cuatro módulos se cargan bajo demanda según la vista; la biblioteca incluye cada PNG en su módulo diferido y la aplicación los sirve como archivos con hash. El anclaje preservado es (0.5, 0.9375), con altura de presentación de 76 unidades. No se seleccionan poses de trabajo ni se infieren acciones desde una imagen estática. La imagen se resuelve combinando facing del snapshot y cámara según docs/crew/FACING.md. La locomoción sigue pendiente. Cualquier derivado debe conservar el original y registrar su procedencia por separado. Una pose estática no acredita un clip animado ni la aceptación visual de una sala.

Piloto acotado de #115: el renderer Crew también usa selectivamente `furniture.desk-executive` y `furniture.plant-floor`, solo para los muebles `ceo-desk` y `ceo-plant` de la sala Dirección (`src/crew/crewPropImages.ts`, `CREW_ROOM_PROP_IMAGES`). El resto de los 51 recursos y las otras diez salas siguen fuera del runtime, dibujando el bloque 2.5D de siempre. Como estos dos SVG pesan menos del límite de inlining de Vite, el bundle los empaqueta como `data:image/svg+xml` dentro de su propio módulo diferido en vez de como archivo con hash; siguen siendo los bytes originales del banco, sin regenerar ni recortar. El banco no tiene vistas verificadas por ángulo para ningún mueble, así que se reutiliza la MISMA imagen en las cuatro cámaras (billboard plano), no cuatro vistas propias por mueble. Si la imagen falla al cargar, el mueble conserva el bloque 2.5D de siempre. Sigue siendo `prototype`, no `approved`.

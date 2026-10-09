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

El manifiesto usa `usage: source-bank`. El renderer Crew utiliza selectivamente las cuatro poses `character.ceo.idle.{front,right,back,left}` para agentes con rol boss presentes en la sala. El resto permanece fuera del runtime. Los cuatro módulos se cargan bajo demanda según la vista; la biblioteca incluye cada PNG en su módulo diferido y la aplicación los sirve como archivos con hash. El anclaje preservado es (0.5, 0.9375), con altura de presentación de 76 unidades. No se seleccionan poses de trabajo ni se infieren acciones desde una imagen estática. Las vistas se corresponden con el preset de cámara; el piloto aún no interpreta la orientación ni locomoción del agente. Cualquier derivado debe conservar el original y registrar su procedencia por separado. Una pose estática no acredita un clip animado ni la aceptación visual de una sala.

# Banco de recursos Crew

Rescate selectivo de 53 originales y una referencia del CEO del [PR #43](https://github.com/jmmana/Agent-Viewer/pull/43), commit `355e9194bd83d8b741bc65d5b58a897d320ee584`. Los archivos conservan sus bytes originales. El manifiesto registra SHA-256, dimensiones, archivo fuente, licencia MIT y procedencia. Se aplica la licencia MIT del repositorio.

- 11 poses de personajes en PNG con canal alfa. Son imágenes de un fotograma, sin animación.
- 20 muebles, 13 electrónicos y 9 efectos en SVG. Sus cuatro perspectivas no están verificadas.
- Una referencia visual del CEO, clasificada como referencia y separada del banco de runtime.

Todos los recursos del banco siguen siendo `prototype`. Las vistas ausentes de personajes se indican explícitamente. El tamaño lógico y el anclaje son metadatos históricos; no definen colisiones ni escala en el modelo espacial Crew. No se importan los estudios vectoriales ni el renderer de #43.

## Comprobación y recuperación

`npm run crew:assets:check` valida el banco sin red ni acceso al historial Git. Se ejecuta también en CI.

`npm run crew:assets:import` recupera los originales desde el commit indicado, que debe existir en el clon local. Es idempotente y rechaza sobrescribir archivos con contenido diferente. No cambia de rama ni fusiona #43.

## Uso posterior

El manifiesto usa `usage: bank-only`. Ningún renderer carga estos archivos y no se distribuyen en el paquete npm. Antes de integrarlos deben revisarse estilo, proporciones, cuatro vistas, anclajes y compatibilidad con el ADR de cámara. Cualquier derivado debe conservar el original y registrar su procedencia por separado. Una pose estática no acredita un clip animado ni la aceptación visual de una sala.

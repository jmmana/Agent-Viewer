# Evidencia del ajuste del puesto CEO

Cierra el alcance #276, Refs #118. El fixture real CrewStage conserva los 64 cuadros del personaje y agrega ocho vistas originales de mesa/silla con contactos medidos de teclado, asiento y pies. El teclado permanece fijo al teclear; las oclusiones intencionales de mesa y respaldo siguen la orientación del actor.

```sh
PLAYWRIGHT_CHANNEL=chrome npx playwright test --config playwright.crew118.config.ts
```

`desktop-{front,right,back,left}.png` y `runtime.mp4` muestran sentarse, teclear, levantarse y girar en la sala CEO aislada. Zoom y móvil provienen de `crew-workstation.spec.ts`. Los datos sintéticos llevan DEMO visible y permanecen de solo lectura. Las pruebas cubren además arte ausente, movimiento reducido, salas vacías y los ocho recortes de origen.

El arte sigue prototype: los dedos se levantan de las teclas durante la alternancia y las proporciones de origen varían ligeramente entre vistas. El cambio de muebles se limita a la presentación del CEO ocupado; no es un catálogo final ni navegación física. Siguen pendientes las demás acciones de #118; llamada se trabaja aparte en #145/PR #274. Esta entrega no certifica #118 completo.

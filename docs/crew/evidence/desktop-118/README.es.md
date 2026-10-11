# Ejecución de escritorio del CEO (Refs #118)

El fixture `tests/e2e/fixtures/crew-desktop.html` monta CrewStage real con DEMO explícito y snapshots sintéticos inmutables. CODING/WRITING inicia sentarse y luego teclear; al salir reproduce levantarse; un cambio de orientación reportada reproduce girar. Es una interpretación visual del estado laboral observado, no evidencia de una persona física sentándose o tecleando. No modifica snapshots LIVE, eventos ni consumo.

Reproducir en el puerto aislado 3118:

```sh
PLAYWRIGHT_CHANNEL=chrome npx playwright test --config playwright.crew118.config.ts
```

Las cuatro capturas de cámara y el MP4 provienen de esta prueba. Verifica recortes reales de las cuatro acciones, orientaciones distintas entre actores, fallback ES/EN, movimiento reducido y salida de sala. Originales en `assets/crew/clips/ceo-{sit,stand,typing}-v1.png` y `ceo-turn-v2.png`; procedencia en `assets/crew/origins/desktop-118/`.

Límites del prototipo: diferencias de proporciones y residuos alfa; proyección discreta de cuatro orientaciones; silla geométrica y escritorio existente como imagen orientada a cámara, sin arte final de muebles en cuatro vistas. La silla se acerca al escritorio solo en la presentación de la escena mientras está ocupada. Las transiciones no implementan trayectorias de aproximación física ni corrección de deslizamiento de pies. Ante carga tardía o fallida permanece el sprite estático. No se certifica arte final ni el CEO completo.

Siguen pendientes en #118: llamada, hablar, pensar, aprobar, revisar, bloqueo, celebrar, café/beber, estirar/bailar, arte final y aceptación completa de coreografías/navegación física. Caminar y parpadear fueron entregados antes. Este PR usa Refs #118 y lo mantiene abierto.

La imagen actual del escritorio no alinea las manos al teclear con su superficie en todas las cámaras. Esta entrega no certifica ese ajuste pendiente entre mueble y actor.

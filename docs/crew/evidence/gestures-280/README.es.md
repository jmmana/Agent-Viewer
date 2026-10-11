# Evidencia runtime de gestos del CEO

Issue #280, Refs #118. [English](README.md).

[runtime.mp4](runtime.mp4) graba el `CrewStage` real, con rótulo DEMO explícito y snapshots sintéticos congelados. Doce PNG muestran pensar/hablar/revisar bajo cámaras front/right/back/left. Los nombres de cámara no son orientaciones del actor: para el actor SE corresponden a arte front/left/back/right. Cada cámara enfoca explícitamente al actor para mantener visibles las cuatro vistas.

Reproducir con `npx playwright test -c playwright.crew118.config.ts tests/e2e/crew-gestures.spec.ts --workers=1`. La prueba graba vídeo y comprueba los cuatro recortes de cada clip en cada cámara, snapshot fuente intacto, ausencia de errores del navegador, cancelación por estado/sala, movimiento reducido y fallback inglés/español ante imagen ausente. Se reutiliza el fixture de escritorio existente, no un renderer alternativo. Convertir su `video.webm` con `ffmpeg -i video.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart runtime.mp4`.

Solo THINKING, CHATTING y REVIEWING seleccionan estos gestos. READING, USING_TOOL e IN_MEETING no los implican. Caminar los cancela; levantarse/girar termina antes de comenzar el gesto solicitado. Se conservan la pausa en pestaña oculta y la cancelación de carga diferida. No se generan ni cambian razonamiento privado, eventos, métricas o consumo.

El arte sigue prototype, con pequeñas diferencias de silueta y ritmo de cuatro fases. Mobiliario y navegación física quedan fuera de esta entrega. #118 permanece abierto por call, approve, blocked, celebrate, coffee/drink, stretch/dance y aceptación final de arte/coreografía. Ver [originales y metadatos](../../../../assets/crew/origins/gestures-118/README.es.md).

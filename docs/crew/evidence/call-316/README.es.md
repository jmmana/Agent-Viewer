# CEO: coger, conversar y colgar

Issue #316, Refs #118 y #145. [English](README.md).

El [MP4 runtime](runtime.mp4) muestra CrewStage real en la sala CEO aislada, con datos sintéticos rotulados DEMO. Cuatro PNG muestran las cámaras; el facing SE del actor corresponde a arte front/left/back/right para cámaras front/right/back/left. `call-mobile-reduced.png` muestra el respaldo neutral y aviso de llamada con movimiento reducido a 390 x 844.

Reproducir: `npx playwright test -c playwright.crew118.config.ts tests/e2e/crew-call-animation.spec.ts --workers=1`. La primera prueba comprueba los cuatro recortes en orden temporal al coger y colgar en reversa, los cuadros de conversación en cada orientación y el retorno a reposo sin seguir dibujando. La segunda cubre dos actores, aislamiento de sala, persistencia de la llamada reportada al volver, móvil/movimiento reducido, fallback ES/EN ante atlas ausente y limpieza al desmontar. `crew-phone-call-145.spec.ts` existente aporta cobertura de eventos LIVE, aviso de llamada y regresión de Caricatura.

Solo el estado reportado `PHONE_CALL` inicia la reproducción. Volver a IDLE/AVAILABLE baja el teléfono antes de reposo; caminar, otra tarea o desaparecer la cancela. Son fases locales de presentación, no timestamps ni órdenes reales de coger/colgar del proveedor. Levantarse termina antes de coger; cambiar orientación reinicia el gesto local de coger tras girar. Salir de sala descarta los cuadros locales, nunca la llamada del host. Aviso/timeline y sonido opt-in existentes siguen independientes. Descartar el aviso no termina la llamada ni su arte. Movimiento reducido o cuadros ausentes conserva arte neutral y el aviso existente. Se comparten imágenes neutrales; los cuadros de teléfono son solo del actor en llamada, evitando que otro CEO herede un teléfono.

Los PNG siguen prototype. Cada perfil usa mano/oreja cercana, por lo que cambiar de perfil no conserva lateralidad anatómica. No se entregan trayectorias físicas, otros roles, conectividad real ni aprobación final de arte. #118 y #145 permanecen abiertos por su alcance restante. [Originales, descartes y prompts](../../../../assets/crew/origins/call-118/README.es.md).

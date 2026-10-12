# Originales de llamada del CEO

Issue #316, Refs #118 y #145. [English](README.md).

Originales seleccionados: `assets/crew/clips/ceo-call-pickup-v3.png` y `ceo-call-v1.png`, ambos **1254 x 1254 PNG RGBA**, generados con `image_gen` integrado. Aquí se guardan los prompts exactos. Referencia de identidad: `ceo-talk-v1.png`; pickup v3 edita v2, y el atlas de conversación usa pickup v3 como referencia. No se editaron, reflejaron ni redimensionaron píxeles tras generar. Arte MIT del repositorio, estado **prototype**.

Cuatro filas (front/right/back/left), cuatro fases por fila: 32 dibujos nuevos. Coger sube el teléfono de la cadera a la oreja en 800 ms. El ciclo de conversación cambia boca y mano libre en 1200 ms. Colgar reutiliza los cuatro recortes originales de coger en orden inverso durante 800 ms; no son otros dieciséis dibujos nuevos. `calls.v1.json` registra 12 clips / 48 referencias a cuadros con dimensiones fuente, hashes, procedencia del prompt, variant, FPS, loop, recortes medidos, anclajes de zapatos y altura de referencia constante por orientación. La presentación lógica sigue en 256 x 352, anclaje (0.5, 0.9375).

V1 se descartó por cambiar de mano en el último cuadro frontal y perder el teléfono en la secuencia izquierda. V2 corrigió el frente pero conservó el defecto izquierdo. La edición focalizada v3 redibuja el brazo cercano de forma continua en la fila izquierda. Se conservan ambos originales descartados y sus prompts, excluidos del runtime. Cada perfil usa la mano/oreja cercana visible; no se conserva la lateralidad anatómica al cambiar entre los dos perfiles. Ninguna dirección se creó mediante reflejo. Pequeñas diferencias de silueta y el ritmo de cuatro fases siguen como límites prototype; no es aprobación final de arte entre cámaras.

Ver [evidencia runtime](../../../../docs/crew/evidence/call-316/README.es.md).

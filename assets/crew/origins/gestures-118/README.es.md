# Originales CEO: pensar, hablar y revisar

Issue #280, Refs #118. [English](README.md).

Tres PNG originales generados con `image_gen` integrado, usando `assets/crew/clips/ceo-typing-v1.png` solo como referencia de identidad/estilo. Los prompts exactos se conservan junto a este archivo. Salidas elegidas: `assets/crew/clips/ceo-{think,talk,review}-v1.png`, cada una **1254 x 1254 RGBA**. No se editaron, redimensionaron, reflejaron ni sintetizaron píxeles tras generar. Licencia de arte del repositorio: MIT. Estado **prototype**, sin aprobación final.

Cada atlas contiene cuatro filas (frente, derecha, espalda, izquierda) con cuatro fases dibujadas por separado. Pensar mueve la mano junto al mentón e inclina la cabeza; hablar cambia boca y gestos de mano abierta; revisar recorre un portapapeles y levanta una hoja. Desde atrás se leen codos/cabeza y el borde del documento. Hablar alterna el brazo gesticulante en las fases centrales frontales. Persisten pequeñas diferencias de dibujo/proporción; son ciclos estilizados de cuatro fases, no captura de movimiento fluido.

`gestures.v1.json` sigue el catálogo existente: dimensiones reales, recortes y anclajes de zapatos medidos, SHA-256 de archivo/cuadro/prompt, variant, FPS, loop, presentación lógica 256 x 352 y anclaje lógico (0.5, 0.9375). Los espacios transparentes entre filas se miden por columna. `referenceHeight` constante por orientación evita que inclinar la cabeza reescale el cuerpo. Cada fase dura 300 ms; el ciclo dura 1200 ms mientras siga el estado reportado. No se introduce locomoción física.

Vídeo runtime y capturas: [evidencia](../../../../docs/crew/evidence/gestures-280/README.es.md).

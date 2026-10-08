# Reviewer y Finance — prompts y procedencia

Generación: herramienta integrada `image_gen`, 2026-10-08; edición/selección y especificación por ChatGPT (OpenAI). Referencia de estilo proporcionada por el usuario: `CEO Office Bean Character Asset Sheet(1).png`. Los outputs son sprites raster individuales con transparencia real, no sustituciones SVG ni hojas de animación.

## Entregables

| Rol | Recurso | Dimensiones físicas | Modo | Alpha | Uso |
|---|---|---|---|---|---|
| Reviewer | `assets/characters/reviewer/idle-front.png` | 1070 × 1470 | RGBA | 0–255 | pose frontal neutral |
| Finance | `assets/characters/finance/idle-front.png` | 1070 × 1470 | RGBA | 0–255 | pose frontal neutral |

Caja lógica de integración: 64 × 88; huella artística prevista aproximadamente 32 × 48. El motor debe ajustar el bounding box de alpha ≥ 16 manteniendo aspecto y anclaje inferior, sin interpretar los márgenes del archivo como tamaño corporal. No interpolar estos archivos para fingir ciclos de caminar: falta producir las vistas y frames de acción contra la misma referencia.

Hay una franja de alpha casi invisible fuera del cuerpo; para recorte lógico usar alpha ≥ 16: Reviewer `(175, 105, 864, 1346)`, Finance `(147, 69, 910, 1407)` en coordenadas de fuente, extremo derecho/inferior exclusivo. Conservar los PNG fuente completos.

Se verificaron cabeza grande, cabello castaño voluminoso, rostro humano visible con lentes, cuerpo de oficina compacto, piernas cortas, manos y zapatos completos, accesorio de rol y fondo alpha. Reviewer incorpora blazer terracota y clipboard; Finance chaleco verde oscuro, camisa blanca, calculadora. No contienen suelo, sombra proyectada ni entorno. Los frames continúan el estilo suavemente sombreado del concepto aprobado.

## Prompt Reviewer

```text
Use case: stylized-concept. Asset type: Agent Viewer office-character front idle transparent sprite, illustration reference for runtime logical box64x88 with art footprint approximately32x48. Input image is STYLE AND PROPORTION REFERENCE: the attached CEO Office Bean character sheet. Create ONE full-body front-facing Reviewer role on true transparent background, no collage. Match the exact premium smooth shaded cartoon/chibi aesthetic of the large front-view CEO on upper left: oversized human head, huge voluminous tousled dark brown hair, warm peach face, friendly large dark eyes behind black business glasses, small compact corporate body, small hands, short visibly separated legs and neat dark shoes. This must look like the SAME ORIGINAL office character family. Human visible face and nose, no visor, no backpack, no spacesuit. Reviewer wears muted terracotta orange tailored formal blazer, white shirt, charcoal tie and trousers, small ID badge; defined slender black rectangular glasses while maintaining broad recognisable glasses footprint. Holds a small clipboard tucked close against left side in left hand; right hand relaxed. Neutral attentive expression and upright idle stance, both shoes on same baseline. Straight-on orthographic front view entire hair to shoes visible, one character centred, generous transparent margins. Crisp continuous outline, rich hair locks, soft material shading matching reference, no pixel art, no flat vector simplification, no realistic adult proportions. No labels text letters logos watermark speech bubbles floor platform environment or baked ground shadow. Genuine transparent alpha outside silhouette. Do not draw reference sheet, only one complete character.
```

## Prompt Finance

```text
Use case: stylized-concept. Asset type: Agent Viewer office-character front idle transparent sprite, illustration reference for runtime logical box64x88 with art footprint approximately32x48. Input image is STYLE AND PROPORTION REFERENCE: the attached CEO Office Bean character sheet. Create ONE full-body front-facing Finance role on true transparent background, no collage. Match the exact premium smooth shaded cartoon/chibi aesthetic of the large front-view CEO on upper left: oversized human head, huge voluminous tousled dark brown hair, warm peach face, friendly large dark eyes behind black business glasses, small compact corporate body, small hands, short visibly separated legs and neat dark shoes. This must look like the SAME ORIGINAL office character family. Human visible face and nose, no visor, no backpack, no spacesuit. Finance wears dark forest-green formal waistcoat over white business shirt, charcoal tie and charcoal trousers, small ID badge; classic black rectangular glasses maintaining broad recognisable glasses footprint. Holds a compact dark digital calculator tucked close against left side in left hand; right hand relaxed. Neutral detail-oriented pleasant expression and upright idle stance, both shoes on same baseline. Straight-on orthographic front view entire hair to shoes visible, one character centred, generous transparent margins. Crisp continuous outline, rich hair locks, soft material shading matching reference, no pixel art, no flat vector simplification, no realistic adult proportions. No labels text letters logos watermark speech bubbles floor platform environment or baked ground shadow. Genuine transparent alpha outside silhouette. Calculator has simple tiny blank keys and a blank display; no writing. Do not draw reference sheet, only one complete character.
```

# ADR-001 — Modo Crew: escenas locales y cámara multiángulo 2.5D

- **Issue:** [#173](https://github.com/jmmana/Agent-Viewer/issues/173)
- **Epic:** [#114](https://github.com/jmmana/Agent-Viewer/issues/114)
- **Estado:** **Propuesto para implementación** (decisión técnica documentada; requiere validación G1 antes de considerar #173 completo)
- **Fecha:** 2026-10-08
- **Restricción principal:** `Caricatura` y `Crew` son dos modos visuales **independientes**. No reutilizar el renderer actual como base de Crew.

## 1. Contexto contrastado con el repositorio

En `main` (revisado antes de esta decisión):
- React 19, TypeScript y Vite; renderer actual **Canvas2D** `src/engine/canvasRenderer.ts`.
- `src/components/OfficeCanvas.tsx` tiene zoom y rotación en **4 pasos de una cuadrícula compartida**, con coordenadas `gridToScreen`; esa rotación no constituye cámara orbital 3D.
- La plataforma proporciona un store/event contract que contiene agentes, tareas, reuniones y uso de tokens. Crew debe **consumirlo en modo lectura**; jamás modificarlo desde las animaciones.
- En la rama `feat/visual-assets-v1` (PR #43 DRAFT) existen imágenes y 4 orientaciones estáticas de CEO, efectos y props SVG, además de **estudios vectoriales** que no corresponden a ciclos raster aprobados. Son recursos candidatos a migración, **no motor Crew implementado**.

El usuario requiere seleccionar **una sola oficina**, verla grande y centrada, hacer **zoom/pan**, cambiar desde **qué lado de la oficina** se observa y volver a la vista anterior, sin afectar la oficina del modo Caricatura.

## 2. Opciones evaluadas

| Opción | Beneficios | Costos y limitaciones | Decisión |
| --- | --- | --- | --- |
| A. Modificar Canvas2D existente con sprites nuevos | Parece rápido; controles básicos ya existen | Viola independencia, hereda grilla global y muestra planta completa; PR #164 demuestra ese riesgo | **Rechazada** |
| B. **Nuevo renderer Crew Canvas2D 2.5D, escenas por habitación y cuatro presets de cámara** | Reutiliza stack sin dependencia pesada; sprite 4 lados + ilustraciones por vista; control fino de superposición; fácil fallback/accessibility | El giro es discreto, no orbital; props/paredes requieren variantes por punto de vista; zoom alto puede revelar límites de resolución | **Elegida para v1** |
| C. WebGL/Three.js ortográfico con geometría 3D de salas y avatares 2D | Cámara más libre, profundidad/sombras mejores | Nuevas geometrías y assets para todos los muebles; billboards se ven incorrectos de lado; complejidad de hit-testing y 3D | **Posible evolución, no v1** |
| D. Sprite/layer rotado como imagen plana | Poca implementación | Mirar desde atrás no muestra realmente espalda/pared posterior; perspectiva falsa | **Prohibida** |

**Decisión:** desarrollar un **motor Crew Canvas2D propio** (no importar renderer legacy) con **rooms autónomas**, coordenadas locales en unidades de mundo, escenas/paredes/muebles **específicos de cada vista**, cuatro cámaras discretas y zoom/pan continuo. No describirlo como cámara 3D orbital ni como 360° libre.

**Extensibilidad:** el contrato de escena y cámara abstrae el render. Si el producto solicita giro orbital libre más adelante, será necesario un ADR separado con migración a geometría/3D real; no prometer orbitación libre con solo cuatro PNG de personaje.

## 3. Especificaciones tipadas

```ts
type CrewCameraView = 'front' | 'right' | 'back' | 'left';
type CrewRoomId = string; // ID del registry, validado antes de abrir

interface CrewCameraState {
  roomId: CrewRoomId;
  view: CrewCameraView;
  zoom: number;    // 0.5..3; configurable por sala y viewport
  panX: number;    // desplazamiento en unidades locales del canvas, sin afectar ubicación real del actor
  panY: number;
}

interface CrewRoom {
  id: CrewRoomId;
  size: { width: number; depth: number; height?: number };
  views: Record<CrewCameraView, CrewViewDefinition>;
  placements: CrewPlacement[];
  navigation: CrewNavigation;
}

interface CrewViewDefinition {
  projection: 'oblique-2_5d'; // 2D pseudoisométrico predefinido, sin perspectiva 3D libre
  visibleWalls: string[];    // paredes en primer plano ocultan o se hacen transparentes por vista
  backgroundLayerIds: string[];
  cameraTarget: { x: number; y: number };
  artAvailability: 'complete' | 'prototype' | 'missing';
}
```

- `roomId` se obtiene del selector Crew; **solo esa escena se monta/dibuja**.
- Cada habitación conserva `cameraByRoomId`; cambios de oficina no resetean estado global/eventos.
- Los actores tienen **posiciones reales locales** y un sprite `facing` correspondiente al ángulo de observación; no se invierte por CSS ni se gira texto horneado.
- Render por capas: suelo→pared trasera→muebles traseros→agentes/props con depth sort local→muebles delanteros→luces/partículas→HUD. Pared frontal puede recortarse/ocultarse para permitir vista del interior.
- Los monitores dibujan una superficie dinámica en posiciones apropiadas solo cuando resultan visibles desde ese ángulo; desde atrás mostrar carcasa o cara posterior.
- `fitRoom` calcula bounds de **la sala seleccionada** con padding, sin usar `GRID_ROWS`, `GRID_COLS` ni `getOfficeRenderedBounds` legacy.
- `zoom` aplica al mundo, no al HUD; `pan` se restringe para mantener parte útil de la sala visible, admitiendo zoom cercano a escritorios.
- Selector de cámara ofrece Frente, Derecha, Atrás e Izquierda, con controles táctiles y teclado y etiquetas ES/EN. Una transición de preset puede ser corte o crossfade de **vistas completas**; nunca giro intermedio de una imagen plana.
- `Reset` restablece zoom/pan al ajuste local; `Focus` centra un actor/desk si existe en la sala.
- Un arte faltante se muestra como placeholder **etiquetado no disponible**, no como perspectiva inventada.

## 4. Matriz de assets por cámara

| Recurso | Frontal | Derecha | Trasera | Izquierda | Restricción |
| --- | --- | --- | --- | --- | --- |
| CEO y demás roles | PNG `front` | PNG `right` | PNG `back` | PNG `left` | 4 facings fieles; frames de movimiento propios |
| Suelo/planta | vista propia | vista propia | vista propia | vista propia | coordenadas locales; geometría compatible |
| Paredes y puertas | variantes/recorte | variantes/recorte | variantes/recorte | variantes/recorte | evitar pared frontal tapando el usuario |
| Escritorio, silla, café | arte / capas de cara visible | arte/capas derecha | arte/capas posterior | arte/capas izquierda | mismo hitbox/anchor, distintas proyecciones |
| Pantallas y televisor | contenido dinámico si visible | perfil o panel si visible | carcasa | perfil opuesto | no reflejar caracteres |
| Burbujas y HUD | siempre orientados a pantalla | igual | igual | igual | legibles a cualquier zoom |

## 5. Flujo UX obligatorio

1. Modo visual: **Caricatura** (por defecto previo, hasta migración) o **Crew**.
2. Entrar Crew → abrir `selectedRoomId` guardado, o primera sala disponible. **NUNCA** dibujar toda la planta.
3. Selector de habitaciones → montar exactamente una instancia del runtime de la habitación, conservar cámara de la anterior.
4. Zoom mouse wheel/pinch/botones +/− con límites, paneo por drag, restablecer y focalizar.
5. Cambiar cámara desde un preset; reemplazar paredes, props y facings coherentemente.
6. Volver a Caricatura → reactivar experiencia vieja sin re-render Crew fuera de pantalla y sin tocar telemetría/event store.
7. En LIVE, sala vacía aparece vacía; DEMO puede incluir actores ficticios visiblemente marcados.

## 6. Riesgos y mitigaciones

1. **Arte existente insuficiente:** PR #43 solo garantiza poses/estudios. Se exigen vistas reales de props, paredes y animaciones antes de marcar terminado. En G1 se aceptan geometrías de test originales con estado `prototype`, no se afirma contenido final.
2. **Perspectiva engañosa:** los cuatro presets requieren diseño visual genuino por vista; no usar `ctx.rotate` sobre la sala renderizada como sustituto.
3. **Rendimiento:** solo una sala montada y un RAF activo; lazy load por room/view, limpiar imágenes/audio/listeners al salir; medir 6/20/50 agentes.
4. **Pantallas activas:** overlay de Canvas por vista; no estirar código/texto horneado en un SVG.
5. **Compatibilidad:** `visualMode='cartoon'` por defecto, fallback a Cartoon ante error de Crew configurable y recuperación visible.
6. **Accesibilidad:** wheel/pinch y controles explícitos teclado/botones; reduced motion respeta clips y transiciones.
7. **Futuro 3D:** interfaz abstrae `CrewRenderer`; WebGL podrá implementarse como backend posterior sin mutar domain store.

## 7. Acceptance test plan de #173 y hito G1

**Entrega documental de #173:** ADR versionado, comparación de enfoques, especificación tipada, matriz de assets y pruebas definidas. No declarar #173 funcionalmente completo hasta demostración del motor real.

**Después, implementación en #166/#167/#170/#168/#169/#156/#171:**

- [ ] Caricatura existente sigue exactamente igual (baseline E2E).
- [ ] Dos salas Crew autónomas (CEO y Development) con backgrounds/mobiliario diferentes.
- [ ] Selector muestra **solo la sala elegida**: cero drawcalls de habitaciones no seleccionadas.
- [ ] Cuatro presets sobre **cada** habitación cambian vistas de paredes, props y facings de forma coherente.
- [ ] Pan, wheel zoom, pinch, +/−, fit y focus funcionan en viewport desktop y móvil.
- [ ] Persistencia por habitación: cambiar CEO→Dev→CEO conserva su cámara.
- [ ] 0 agentes LIVE: sala vacía; evento de Development no mueve figura CEO.
- [ ] Salir de Crew elimina RAF, handles y audio; dominio/replay/usage siguen intactos.
- [ ] Capturas 4 vistas × 2 habitaciones, MP4 de navegación y tests reproducibles.
- [ ] Build/lint/tests/CI verde sin merge automático del PR #43.

## 8. Dependencias, secuencia y exclusiones

`#173 ADR → #166 two modes → #167 Crew renderer → #170 independent rooms → #168 selector → #169 isolation → #156 cameras → #171 persistence → #155 events → #159 G1 E2E`.

- Reusar **assets originales** del PR #43 mediante #172, no su lógica de inyección a `OfficeCanvas`.
- Caricatura continúa visible y funcional; **no borrar ni fusionar el PR #43 por conveniencia**.
- No requiere traer WebGL/Three.js a las dependencias de producción en esta fase.
- No incluye diseños finales de muebles/personajes, audio, iluminación final ni 360° orbital real; esos trabajos corresponden a issues del Epic.

# Crew — Matriz de migración de recursos del PR #43

Relacionado: [Epic #114](https://github.com/jmmana/Agent-Viewer/issues/114), [#172](https://github.com/jmmana/Agent-Viewer/issues/172), [#115](https://github.com/jmmana/Agent-Viewer/issues/115), [PR #43](https://github.com/jmmana/Agent-Viewer/pull/43).

**Fecha:** 2026-10-08. **Fuente concreta:** `assets/asset-manifest.json` de rama `feat/visual-assets-v1` (PR #43; DRAFT). **No incluido en main.**

## Advertencias
- El inventario tiene **53** entradas runtime, todas con `status: prototype` en la revisión consultada. No confundirse con assets `approved`.
- `Caricatura` sigue usando `src/engine/canvasRenderer.ts` y `src/components/OfficeCanvas.tsx`. **NO importarlos a Crew**; los assets pueden compartirse mediante catálogo migrado, contratos puros y licencias.
- [PR #164](https://github.com/jmmana/Agent-Viewer/pull/164) insertó 4 ilustraciones en el renderer viejo: eso es un ensayo técnico, NO implementación de la oficina Crew nueva.
- Los 1.584 SVG `vector-study` son estudios técnicos, NO la animación raster final; mantener fuera de runtime Crew.
- Las alegaciones de código local en otra sesión siguen **no verificadas** sin commits o material original.

## Trazabilidad completa por ID

| ID del manifest | Archivo fuente en PR #43 | Estado observado | Acción en Crew | Bloqueador |
| --- | --- | --- | --- | --- |
| `character.ceo.idle.front` | `assets/characters/ceo/idle-front.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.ceo.idle.back` | `assets/characters/ceo/idle-back.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.ceo.idle.left` | `assets/characters/ceo/idle-left.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.ceo.idle.right` | `assets/characters/ceo/idle-right.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.ceo.work.front` | `assets/characters/ceo/work-front.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.ceo.phone.front` | `assets/characters/ceo/phone-front.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.planner.idle.front` | `assets/characters/planner/idle-front.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.developer.idle.front` | `assets/characters/developer/idle-front.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.analyst.idle.front` | `assets/characters/analyst/idle-front.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.reviewer.idle.front` | `assets/characters/reviewer/idle-front.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `character.finance.idle.front` | `assets/characters/finance/idle-front.png` | `prototype` | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | #116 #117 #118-127 (4 vistas, variantes y clips) |
| `furniture.desk-workstation` | `assets/furniture/desk-workstation.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.desk-executive` | `assets/furniture/desk-executive.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.chair-ergonomic` | `assets/furniture/chair-ergonomic.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.chair-executive` | `assets/furniture/chair-executive.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.meeting-table` | `assets/furniture/meeting-table.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.sofa-lounge` | `assets/furniture/sofa-lounge.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.coffee-table` | `assets/furniture/coffee-table.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.plant-floor` | `assets/furniture/plant-floor.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.plant-desk` | `assets/furniture/plant-desk.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.bookshelf` | `assets/furniture/bookshelf.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.filing-cabinet` | `assets/furniture/filing-cabinet.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.desk-lamp` | `assets/furniture/desk-lamp.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.whiteboard` | `assets/furniture/whiteboard.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.kanban-board` | `assets/furniture/kanban-board.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.coffee-bar` | `assets/furniture/coffee-bar.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.stool` | `assets/furniture/stool.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.coffee-cup` | `assets/furniture/coffee-cup.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.clipboard` | `assets/furniture/clipboard.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.headphones` | `assets/furniture/headphones.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `furniture.document-folder` | `assets/furniture/document-folder.svg` | `prototype` | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | #130 #141 #170 #173 (layout y ángulos) |
| `electronics.monitor` | `assets/electronics/monitor.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.dual-monitor` | `assets/electronics/dual-monitor.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.laptop` | `assets/electronics/laptop.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.tv-display` | `assets/electronics/tv-display.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.office-phone` | `assets/electronics/office-phone.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.conference-camera` | `assets/electronics/conference-camera.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.speakerphone` | `assets/electronics/speakerphone.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.coffee-machine` | `assets/electronics/coffee-machine.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.water-dispenser` | `assets/electronics/water-dispenser.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.router` | `assets/electronics/router.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.tablet` | `assets/electronics/tablet.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.smartphone` | `assets/electronics/smartphone.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `electronics.calculator` | `assets/electronics/calculator.svg` | `prototype` | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | #130 #142 #170 (cara de pantalla) |
| `effect.wifi` | `assets/effects/wifi.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |
| `effect.call` | `assets/effects/call.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |
| `effect.check` | `assets/effects/check.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |
| `effect.blocked` | `assets/effects/blocked.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |
| `effect.tool` | `assets/effects/tool.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |
| `effect.thought` | `assets/effects/thought.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |
| `effect.alert` | `assets/effects/alert.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |
| `effect.sync` | `assets/effects/sync.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |
| `effect.terminal` | `assets/effects/terminal.svg` | `prototype` | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | #153 #155 (origen eventos) |

## Propiedades y destinos por categoría

| Tipo | Cantidad | Decisión | Implementación prohibida |
|---|---:|---|---|
| character | 11 | Migrar PNG como referencia/prototipo al atlas del renderer Crew; completar 4 vistas y clips genuinos antes de aprobar. | No hacer “skin” del Canvas de Caricatura |
| furniture | 20 | Reutilizar SVG original con licencia/provenance; dibujar versiones coherentes por vista Crew y hitbox/anchor local. | No hacer “skin” del Canvas de Caricatura |
| electronics | 13 | Conservar carcasa SVG; proyectar/animar pantalla mediante CrewScreenSurface según ángulo y datos reales. | No hacer “skin” del Canvas de Caricatura |
| effect | 9 | Migrar símbolo a capa de eventos Crew; activar solo por evento real LIVE o DEMO rotulado. | No hacer “skin” del Canvas de Caricatura |

## Material sin manifest runtime

| Fuente | Estado | Acción |
| --- | --- | --- |
| `assets/references/ceo-approved-concept.png` | Referencia de estilo, no clip | Conservar sin alterar; comparar identidad visual de nuevos sprites |
| `assets/rooms/{director-suite,meeting-room,coffee-area}/layout.json` | 3 escenas de showroom, no escenas operativas Crew | Migrar ideas/placements útiles a `CrewRoomDefinition` local, adaptando escalas y ángulos; no reusar `OFFICE_FURNITURE` |
| `assets/characters/*/vector-study/**` | 1.584 estudios SVG con estilo distinto | Conservar como estudio/source, nunca contar como aprobación del movimiento |
| `src/engine/officeCrewAssets.ts` | Loader orientado al renderer legacy | Reusar principios de caché/manifest, **no** importar el módulo de drawing en runtime Crew |
| `src/visual-studio/**` | Galería y escenas de prueba | Usar como banco QA comparativo; no confundir con el nuevo motor |
| `src/engine/officeFurnitureAssets.ts` | Piloto PR #164 para grilla vieja | Solo referencia; no copiar la inyección `renderFurnitureItem` a Crew |
| `scripts/register-office-clip.mjs` y validador | Infraestructura parcialmente reutilizable | Adaptar paths y contrato a Crew, manteniendo chequeos RGBA y frames distintos |

## Reglas de importación y entregable de #172

1. Crear inventario portable por ID/archivo/provenance, `sourceBranch`, versión, licencia, dimensiones, `viewAvailability`, tipo y estado; no mudar directorios hasta verificar consumidores de PR #43.
2. No cambiar `main` Caricatura para preparar Crew. Extraer recursos originales mediante directorio/módulo compartido y mantener rollback.
3. Mostrar solo una escena `roomId` Crew; cámara `front/right/back/left` requiere artwork correcto de cada lado y puede mostrar placeholder etiquetado por falta de vista.
4. Antes de cerrar #172 verificar visualmente los recursos importados en el motor nuevo y ausencia de regresiones legacy.
5. La documentación no certifica implementación runtime: assets aún **candidatos**, no transferidos, salvo prueba explícita.

## Próximos pasos automáticos
- #166, #167, #170: completar motor y escena local independiente.
- #168/#169/#156/#171: selector de habitación, visibilidad aislada, cámara y preferencias.
- #118-127: producir sprites, variantes y gestos verdaderos; #130-154: migrar props y efectos a escenas Crew.
- #159: QA de los dos modos; #161: no cerrar ni retirar Caricatura sin autorización.

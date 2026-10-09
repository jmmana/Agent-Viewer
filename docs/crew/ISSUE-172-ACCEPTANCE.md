# Auditoría de aceptación de Crew-007 (#172)

**Auditoría:** 2026-10-09  
**Alcance:** evidencia disponible en `main` y en los artefactos fuente revisados; no se declara aceptación visual ni se sustituye la aprobación de arquitectura/QA.

## Resultado

La trazabilidad documental y la preservación de originales están demostradas. La decisión de mantener un renderer Crew independiente también está reflejada en la implementación actual y en la separación entre el banco de assets y el runtime. #172 **no está listo para cerrarse**: falta aprobación visual explícita por recurso y de la sala con el arte candidato, además de la aceptación del diseño/contratos por las personas responsables. Los prototipos no se consideran arte aprobado.

## Criterios bloqueantes

| Criterio | Estado | Evidencia verificable | Pendiente para aceptarlo |
| --- | --- | --- | --- |
| Trazabilidad de cada asset técnico y destino Crew/descarte temporal | Satisfecho documentalmente | [Matriz por ID](ASSET-MIGRATION-PR43.md) clasifica los 53 recursos del manifest, identifica archivo fuente, estado, destino y bloqueadores. Incluye materiales fuera del manifest y el renderer legado que no se debe importar. `assets/crew/asset-manifest.json` registra procedencia individual de los 53 recursos runtime y la referencia. | La matriz es una decisión de migración, no aprobación de cada pieza para producción. Completar QA visual antes de cambiar estados de prototipo. |
| Conservar todos los PNG originales y arte aprobado, con procedencia y sin regeneración innecesaria | Satisfecho para el banco auditado | El commit fuente es `355e9194bd83d8b741bc65d5b58a897d320ee584`. Comparación directa `git show <commit>:<sourceFile>` contra cada archivo en el banco: **54/54 bytes idénticos**, hashes coincidentes, cero diferencias. Incluye 53 recursos y `reference.ceo`; el manifiesto indica MIT, commit y ruta de origen. | No hay una declaración de aprobación visual del conjunto: los 53 assets están en `prototype`; la imagen CEO separada está clasificada como referencia. No elevar estados sin revisión humana. |
| Los 1.584 fotogramas SVG son estudios, no animación final | Satisfecho | La matriz los identifica como estudios fuera del runtime y explicita que no acreditan movimiento aprobado. El PR #43 declara que los ciclos raster finales siguen pendientes. Conteo reproducido en el árbol del commit fuente: `git ls-tree -r --name-only 355e9194... | rg 'vector-study/.*\.svg$' | wc -l` devuelve **1584**. | Ninguno para este criterio. No incluir dichos SVG como clips finales. |
| #164 no se considera implementación definitiva del Modo Crew | Satisfecho | PR #164 está fusionado (`355e9194…`), pero la matriz clasifica `officeFurnitureAssets.ts` y su inyección al Canvas de Caricatura como referencia/piloto legado. La oficina Crew actual tiene renderer propio en `src/crew/`; su banco no importa el módulo de drawing anterior. | Mantener esta frontera en cualquier integración futura de muebles. |
| #43 no se fusiona como reemplazo total sin revisión de arquitectura y QA dual | Satisfecho al momento de auditoría | `gh pr view 43`: estado `OPEN`, `isDraft: true`, base `main`, sin merge commit. La matriz prohíbe usar el Canvas de Caricatura como destino Crew y exige QA de ambos modos. PRs #162, #163 y #164 sí están fusionados, pero no convierten #43 en implementación final. | No fusionar #43 como sustitución total. Una eventual decisión requiere revisión de arquitectura y QA dual documentados. |

## Evidencia de cierre aún no satisfecha

| Evidencia pedida por el issue | Estado observado | Evidencia / límite |
| --- | --- | --- |
| Diseño técnico y contratos aceptados, sin ambigüedades | Pendiente de aceptación | Hay una estrategia técnica en la matriz y contratos/runtime Crew posteriores en `docs/crew/`. No encontré constancia de aprobación explícita de esos contratos para cerrar #172. La auditoría no sustituye esa aprobación. |
| Test unitario y E2E del alcance; no regresión Caricatura | Parcialmente satisfecho | `tests/crew-assets.test.mjs` prueba conteo, integridad/hash, dimensiones, licencia, estados, perspectivas y prevención de animación inventada. El estado compartido registra suites E2E Crew y una comparación de píxeles al regresar a Caricatura. No se volvieron a ejecutar browser/E2E en esta auditoría; la verificación aquí se limitó al banco y su prueba Node. |
| Capturas/GIF/MP4 del Modo Crew corriendo | Parcial; no demuestra aceptación de arte | Hay capturas y videos documentados en `docs/crew/IMPLEMENTATION-STATUS.md`, incluyendo recorrido de runtime y piloto CEO. El propio estado los identifica como geometría/prototipos, y no encontré una revisión visual aprobatoria de los 53 assets ni de una sala final con todos ellos. |
| PR y checks CI aprobados con trazabilidad de assets/eventos | Parcial | El banco llegó por PR #194 y el estado compartido registra CI aprobado para ese cambio. Esta auditoría no presenta un check de CI de su propio PR hasta que se ejecute. La trazabilidad documental de assets existe; no equivale a la aceptación visual pendiente. |

## Resultado de integridad reproducido

Comandos ejecutados en `docs/crew-172-audit`:

```text
node --input-type=module -e '<comparar bytes de cada fuente git con el archivo del manifiesto>'
  checked: 54, matched: 54, mismatches: []
npm run crew:assets:check
  assets: 53; character: 11; furniture: 20; electronics: 13; effect: 9; reference: reference.ceo
node --import tsx --test tests/crew-assets.test.mjs
  11 tests passed
```

El script `crew:assets:import` recupera del commit fijo y rechaza sobrescribir archivos distintos; no cambia de rama ni fusiona #43. El banco está clasificado como `source-bank` y no se importa en runtime de forma global. Las cuatro poses idle del CEO usadas por el piloto son un caso de uso acotado; siguen siendo prototipos estáticos, no prueba de arte final o de animación laboral.

## Recomendación

Mantener #172 abierto. La auditoría cubre la trazabilidad, la clasificación de estudios y la política de preservación, pero cerrar ahora convertiría evidencia de integridad técnica en una aprobación visual que no existe. Para cierre se necesita registrar aprobación de diseño/contratos y una revisión visual del arte candidato en Crew, acompañada de QA de no regresión Caricatura y CI aprobado para el cambio que complete esa aceptación. No fusionar #43 como reemplazo total.

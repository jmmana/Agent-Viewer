# Auditoría de aceptación de Crew-007 (#172)

**Auditoría:** 2026-10-09  
**Alcance:** evidencia disponible en `main` y en los artefactos fuente revisados; no se declara aceptación visual ni se sustituye la aprobación de arquitectura/QA.

## Resultado

La migración y auditoría de #172 están satisfechas en su alcance: inventario trazable, recuperación no destructiva, clasificación de prototipos/estudios, renderer Crew independiente, pruebas y evidencia de funcionamiento. El diseño de renderer independiente fue aceptado en ADR #174; el runtime, banco de originales y CI fueron integrados y aprobados en PR #194. Esto no aprueba los prototipos como arte final: completar personajes, animaciones y props finales pertenece a los issues de producción de arte que la matriz ya referencia.

## Criterios bloqueantes

| Criterio | Estado | Evidencia verificable | Pendiente para aceptarlo |
| --- | --- | --- | --- |
| Trazabilidad de cada asset técnico y destino Crew/descarte temporal | Satisfecho | [Matriz por ID](ASSET-MIGRATION-PR43.md) clasifica los 53 recursos del manifest, identifica archivo fuente, estado, destino y bloqueadores. Incluye materiales fuera del manifest y el renderer legado que no se debe importar. `assets/crew/asset-manifest.json` registra procedencia individual de los 53 recursos runtime y la referencia. | Ninguno para el alcance de auditoría/migración. |
| Conservar todos los PNG originales y arte aprobado, con procedencia y sin regeneración innecesaria | Satisfecho para los originales migrados | El commit fuente es `355e9194bd83d8b741bc65d5b58a897d320ee584`. Comparación directa `git show <commit>:<sourceFile>` contra cada archivo en el banco: **54/54 bytes idénticos**, hashes coincidentes, cero diferencias. Incluye 53 recursos y `reference.ceo`; el manifiesto indica MIT, commit y ruta de origen. Los derivados posteriores están separados y trazados; no reemplazan originales. Los recursos conservan su clasificación `prototype` o `reference`. | Ninguno. Mantener los derivados separados y no reclasificar prototipos como aprobados sin revisión de arte. |
| Los 1.584 fotogramas SVG son estudios, no animación final | Satisfecho | La matriz los identifica como estudios fuera del runtime y explicita que no acreditan movimiento aprobado. El PR #43 declara que los ciclos raster finales siguen pendientes. Conteo reproducido en el árbol del commit fuente: `git ls-tree -r --name-only 355e9194... | rg 'vector-study/.*\.svg$' | wc -l` devuelve **1584**. | Ninguno para este criterio. No incluir dichos SVG como clips finales. |
| #164 no se considera implementación definitiva del Modo Crew | Satisfecho | PR #164 está fusionado (`355e9194…`), pero la matriz clasifica `officeFurnitureAssets.ts` y su inyección al Canvas de Caricatura como referencia/piloto legado. La oficina Crew actual tiene renderer propio en `src/crew/`; su banco no importa el módulo de drawing anterior. | Mantener esta frontera en cualquier integración futura de muebles. |
| #43 no se fusiona como reemplazo total sin revisión de arquitectura y QA dual | Satisfecho al momento de auditoría | `gh pr view 43`: estado `OPEN`, `isDraft: true`, base `main`, sin merge commit. La matriz prohíbe usar el Canvas de Caricatura como destino Crew y exige QA de ambos modos. PRs #162, #163 y #164 sí están fusionados, pero no convierten #43 en implementación final. | No fusionar #43 como sustitución total. Una eventual decisión requiere revisión de arquitectura y QA dual documentados. |

## Evidencia de cierre documentada

| Evidencia pedida por el issue | Estado observado | Evidencia / límite |
| --- | --- | --- |
| Diseño técnico y contratos aceptados, sin ambigüedades | Satisfecho | ADR de renderer independiente aceptado en [PR #174](https://github.com/jmmana/Agent-Viewer/pull/174), y runtime integrado en [PR #194](https://github.com/jmmana/Agent-Viewer/pull/194). El contrato de banco especifica IDs, fuentes, licencia, hashes, dimensiones, perspectiva disponible y estado. |
| Test unitario y E2E del alcance; no regresión Caricatura | Satisfecho | `tests/crew-assets.test.mjs` verifica conteo, integridad/hash, dimensiones, licencia, estados, perspectivas y prevención de animación inventada. PR #194 integró runtime Crew y banco con CI verde, incluidos `crew-browser` y los checks generales. El estado de implementación registra E2E de navegación Crew, carga del CEO por vista y prueba de igualdad de píxeles al regresar a Caricatura. Esta auditoría no reejecutó E2E. |
| Capturas/GIF/MP4 del Modo Crew corriendo | Satisfecho como evidencia funcional del prototipo | [Recorrido del runtime](evidence/camera-156/runtime-navigation.mp4), [cuatro vistas CEO](evidence/ceo-118/four-views.mp4), capturas de [CEO](evidence/ceo-118/) y [regreso a Caricatura](evidence/camera-156/cartoon-return.png). Estas pruebas evidencian comportamiento del prototipo; no certifican arte final. |
| PR y checks CI aprobados con trazabilidad de assets/eventos | Satisfecho para la integración auditada | [PR #194](https://github.com/jmmana/Agent-Viewer/pull/194) fusionado el 2026-10-09; CI previo y posterior al merge aprobado según [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md), incluidos navegador, CLI, Python y contenedores. El manifiesto cubre origen/hash de assets; las pruebas de runtime comprueban que su uso depende del estado y vista Crew. |

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

El script `crew:assets:import` recupera del commit fijo y rechaza sobrescribir archivos distintos; no cambia de rama ni fusiona #43. El banco está clasificado como `source-bank`; el runtime incorpora solo recursos que necesita, mediante el renderer Crew independiente. Las cuatro poses idle del CEO usadas por el piloto son un caso de uso acotado; siguen siendo prototipos estáticos, no arte final ni animación laboral.

## Recomendación

Recomiendo cerrar #172 una vez aprobado el PR de esta auditoría documental. Los criterios propios de migración están satisfechos y respaldados por pruebas, trazabilidad, evidencia de runtime y CI en PR #194. La aprobación visual de prototipos como arte final no forma parte de este cierre: esos recursos permanecen etiquetados y los issues de arte/animación referenciados siguen siendo el lugar adecuado para completar su producción. #43 permanece abierto como draft y no debe fusionarse como reemplazo total sin revisión de arquitectura y QA dual.

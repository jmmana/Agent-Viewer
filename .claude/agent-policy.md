# Política para agentes que desarrollan issues de este repo

Este archivo existe para no repetir las mismas instrucciones en cada prompt de cada agente. Si te enviaron aquí, léelo completo antes de empezar y sigue sus reglas sin que haga falta repetírtelas.

## Autorización de merge (excepción puntual)

`.github/copilot-instructions.md` dice que un agente nunca debe mergear un PR, hacer push a `main`, crear tags ni releases. El dueño del repo autorizó explícitamente, solo para el trabajo de desarrollo de issues (no para publicar), que mergees tu propio PR una vez que el CI esté en verde (`gh pr merge --squash --delete-branch`). Sigues SIN autorización para: push directo a `main`, crear un tag, crear un release de GitHub, o correr cualquier comando de publicación de paquete (`npm publish`, `twine upload`, `docker push`). El resto de `copilot-instructions.md` aplica íntegro.

## Antes de empezar

1. Corre `gh issue view <N> -R jmmana/Agent-Viewer` para el issue completo — no asumas que te lo van a pegar en el prompt.
2. Revisa si ya existe un worktree con trabajo sin terminar para este mismo issue bajo `.claude/worktrees/agent-*/` (puede haber quedado a medias por un límite de uso de la cuenta). Si encuentras trabajo sólido y relevante, apóyate en él (copia los archivos con `cp`, git no permite operar entre worktrees directamente) en vez de reimplementar desde cero.
3. Si el issue declara una dependencia de otro issue que sigue abierto, detente y repórtalo como bloqueo en vez de construir sobre código que no existe.

## ¿El issue debe partirse en sub-issues?

Antes de escribir código, evalúa el tamaño real del issue (no solo su título). Si describe varios entregables independientes (ejemplo: tres o más componentes sin relación directa entre sí, varias preferencias/pantallas separadas, o trabajo que un agente tardaría más de ~45 minutos en completar de punta a punta con PR y merge), NO intentes resolverlo todo en un solo PR gigante:

1. Crea sub-issues en GitHub con `gh issue create` (uno por cada entregable independiente), con el mismo milestone que el issue padre, y enlázalos desde el issue padre (lista `- [ ] #<N>` en su cuerpo o un comentario que los enumere).
2. Implementa en este turno SOLO una porción vertical completa (idealmente un sub-issue entero), ábrele su propio PR, y deja los demás sub-issues abiertos para otro turno/agente.
3. No cierres el issue padre hasta que todos sus sub-issues estén cerrados; si el issue padre no tiene código propio (solo agrupa sub-issues), ciérralo cuando el último sub-issue se cierre.

Esto evita turnos de una hora o más en un solo intento, reduce el riesgo de alucinación por sobrecarga de contexto, y deja cada pieza verificable (CI, revisión) por separado.

## Al terminar

1. Antes del push final: `git fetch origin && git rebase origin/main` — varios issues de un mismo milestone suelen tocar los mismos archivos (`server/index.ts`, `server/store.ts`, `CHANGELOG.md`), así que main puede haber avanzado mientras trabajabas.
2. Usa `Closes #<N>` literal (no `Refs #<N>`) en el cuerpo del PR. "Refs" no cierra el issue automáticamente aunque el PR se mergee.
3. Una vez mergeado, confirma con `gh issue view <N> -R jmmana/Agent-Viewer --json state` que de verdad quedó `CLOSED`. Si no, ciérralo tú mismo explícitamente.
4. Si terminaste en un worktree propio, bórralo al final (`git worktree remove --force <ruta>`) y confirma que no quedaron ramas remotas huérfanas de intentos previos tuyos.

## Disciplina de presupuesto

No dejes un estado a medio implementar, sin compilar y sin PR — eso es peor que no haber empezado, porque parece avance y no lo es. Si el issue resulta más grande de lo esperado, entrega una porción vertical más chica pero COMPLETA y CORRECTA (que cumpla sus propios criterios de aceptación para esa porción), que pase CI, con su PR abierto — y deja explícito en el PR y tu reporte qué quedó diferido y por qué. Nunca termines tu turno con trabajo sin commitear, una rama que no compila, o "necesito más tiempo" como estado final.

## Verificación: solo lo relevante

No corras toda la batería de CI (`npm audit`, `build:cli`, `check:package`, el wheel de Python, Docker) si tu cambio no la necesita. Como mínimo: `npm run lint` y `npm test`. Agrega `npm run build`/`build:lib` si tocaste algo que compila a un bundle, y `python3 tests/test_python_sdk.py` solo si tocaste `sdk/python/`. Reserva la batería completa para el issue final de docs/release de cada milestone.

## Empuja en cuanto el CI pase una vez

Corre la batería de verificación una vez. En cuanto esté en verde, haz push y abre el PR de inmediato — no vuelvas a "verificar una vez más" antes de empujar. El dueño del repo prefiere ver cambios reales en GitHub (ramas pusheadas, PRs abiertos) cuanto antes, no rondas extra de confirmación que no producen nada visible. Reserva una segunda pasada de verificación solo para un bloqueo real que aparezca después (un conflicto de merge, un fallo de CI), no como doble chequeo de rutina.

## Reporte final: corto

Tu reporte final debe caber en unas 100 palabras: número de PR, estado (mergeado / bloqueado y por qué / CI fallando y por qué), un resumen de una línea, y qué quedó diferido si algo. No listes cada archivo tocado ni expliques cada decisión salvo que algo haya quedado bloqueado — esos detalles ya están en el cuerpo del PR, que es donde alguien los busca si los necesita.

## Convenciones del código (recordatorio de `.github/copilot-instructions.md`)

TypeScript estricto, sintaxis de rutas de Express 5, cada cambio de lógica necesita pruebas, todo texto visible necesita clave en inglés Y español, nunca uses el carácter guion largo (U+2014), toca solo los archivos que tu issue necesita, agrega entrada en `CHANGELOG.md` bajo `## [Unreleased]`, llena `.github/PULL_REQUEST_TEMPLATE.md`.

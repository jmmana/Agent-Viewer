# Política para agentes que desarrollan issues de este repo

Este archivo existe para no repetir las mismas instrucciones en cada prompt de cada agente. Si te enviaron aquí, léelo completo antes de empezar y sigue sus reglas sin que haga falta repetírtelas.

## Autorización de merge (excepción puntual)

`.github/copilot-instructions.md` dice que un agente nunca debe mergear un PR, hacer push a `main`, crear tags ni releases. El dueño del repo autorizó explícitamente, solo para el trabajo de desarrollo de issues (no para publicar), que mergees tu propio PR una vez que el CI esté en verde (`gh pr merge --squash --delete-branch`). Sigues SIN autorización para: push directo a `main`, crear un tag, crear un release de GitHub, o correr cualquier comando de publicación de paquete (`npm publish`, `twine upload`, `docker push`). El resto de `copilot-instructions.md` aplica íntegro.

## Antes de empezar

1. Corre `gh issue view <N> -R jmmana/Agent-Viewer` para el issue completo — no asumas que te lo van a pegar en el prompt.
2. Revisa si ya existe un worktree con trabajo sin terminar para este mismo issue bajo `.claude/worktrees/agent-*/` (puede haber quedado a medias por un límite de uso de la cuenta). Si encuentras trabajo sólido y relevante, apóyate en él (copia los archivos con `cp`, git no permite operar entre worktrees directamente) en vez de reimplementar desde cero.
3. Si el issue declara una dependencia de otro issue que sigue abierto, detente y repórtalo como bloqueo en vez de construir sobre código que no existe.

## Al terminar

1. Antes del push final: `git fetch origin && git rebase origin/main` — varios issues de un mismo milestone suelen tocar los mismos archivos (`server/index.ts`, `server/store.ts`, `CHANGELOG.md`), así que main puede haber avanzado mientras trabajabas.
2. Usa `Closes #<N>` literal (no `Refs #<N>`) en el cuerpo del PR. "Refs" no cierra el issue automáticamente aunque el PR se mergee.
3. Una vez mergeado, confirma con `gh issue view <N> -R jmmana/Agent-Viewer --json state` que de verdad quedó `CLOSED`. Si no, ciérralo tú mismo explícitamente.
4. Si terminaste en un worktree propio, bórralo al final (`git worktree remove --force <ruta>`) y confirma que no quedaron ramas remotas huérfanas de intentos previos tuyos.

## Disciplina de presupuesto

No dejes un estado a medio implementar, sin compilar y sin PR — eso es peor que no haber empezado, porque parece avance y no lo es. Si el issue resulta más grande de lo esperado, entrega una porción vertical más chica pero COMPLETA y CORRECTA (que cumpla sus propios criterios de aceptación para esa porción), que pase CI, con su PR abierto — y deja explícito en el PR y tu reporte qué quedó diferido y por qué. Nunca termines tu turno con trabajo sin commitear, una rama que no compila, o "necesito más tiempo" como estado final.

## Verificación: solo lo relevante

No corras toda la batería de CI (`npm audit`, `build:cli`, `check:package`, el wheel de Python, Docker) si tu cambio no la necesita. Como mínimo: `npm run lint` y `npm test`. Agrega `npm run build`/`build:lib` si tocaste algo que compila a un bundle, y `python3 tests/test_python_sdk.py` solo si tocaste `sdk/python/`. Reserva la batería completa para el issue final de docs/release de cada milestone.

## Reporte final: corto

Tu reporte final debe caber en unas 100 palabras: número de PR, estado (mergeado / bloqueado y por qué / CI fallando y por qué), un resumen de una línea, y qué quedó diferido si algo. No listes cada archivo tocado ni expliques cada decisión salvo que algo haya quedado bloqueado — esos detalles ya están en el cuerpo del PR, que es donde alguien los busca si los necesita.

## Convenciones del código (recordatorio de `.github/copilot-instructions.md`)

TypeScript estricto, sintaxis de rutas de Express 5, cada cambio de lógica necesita pruebas, todo texto visible necesita clave en inglés Y español, nunca uses el carácter guion largo (U+2014), toca solo los archivos que tu issue necesita, agrega entrada en `CHANGELOG.md` bajo `## [Unreleased]`, llena `.github/PULL_REQUEST_TEMPLATE.md`.

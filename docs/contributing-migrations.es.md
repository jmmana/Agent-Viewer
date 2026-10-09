# Contribuir con migraciones SQLite

Las migraciones SQLite son solo hacia delante y definen el registro de eventos en disco. Nunca edites ni reordenes una migración publicada y no añadas migraciones de reversión.

## Añadir una migración

1. Añade `server/db/migrations/000N-name.ts` con la siguiente versión consecutiva y un nombre kebab-case estable.
2. Añádela al final de `MIGRATIONS` en `server/db/migrations.ts`. Mantén sin cambios todos los pares `[version, name]` publicados.
3. Incluye los cambios de esquema en `up(db)`. El ejecutor abre una transacción. No uses pragmas que cambien el estado, incluidos `journal_mode`, `synchronous` o `foreign_keys`; se permiten los pragmas de solo lectura, como `table_info`.
4. Actualiza o añade pruebas de migración. Una migración debe conservar los datos de eventos y su orden, salvo que el issue de la hoja de ruta indique explícitamente lo contrario.
5. Añade el nuevo par `[version, name]` a `tests/fixtures/sqlite/migrations.snapshot.json`.

## Fixtures

Los fixtures reproducen bases creadas por una versión publicada. Genera uno a partir de la referencia histórica de Git:

```bash
node scripts/sqlite-fixtures/generate.mjs <git-ref> tests/fixtures/sqlite/<nombre-del-fixture>.db
```

El generador crea un worktree temporal, añade los eventos fijos de `tests/fixtures/sqlite/events.json`, sincroniza la base y elimina el worktree. Tras regenerar un fixture, actualiza su referencia, SHA-256 y número de filas en `tests/fixtures/sqlite/manifest.json`. Mantén pequeños los fixtures y nunca uses datos reales de clientes o usuarios.

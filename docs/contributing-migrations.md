# Contributing SQLite migrations

SQLite migrations are forward-only and define the on-disk event record. Never edit or reorder a migration after it has been released, and never add a down migration.

## Adding a migration

1. Add `server/db/migrations/000N-name.ts` with the next contiguous version and a stable kebab-case name.
2. Append it to `MIGRATIONS` in `server/db/migrations.ts`. Keep every released `[version, name]` pair unchanged.
3. Put schema changes in `up(db)`. The runner wraps it in a transaction. Do not run pragmas that change state, including `journal_mode`, `synchronous` or `foreign_keys`; read-only pragmas such as `table_info` are allowed.
4. Update or add migration tests. A migration must preserve existing event data and row order unless its roadmap issue explicitly specifies otherwise.
5. Append the new `[version, name]` pair to `tests/fixtures/sqlite/migrations.snapshot.json`.

## Fixtures

Fixtures reproduce databases created by released code. Generate one from the selected historical git ref with:

```bash
node scripts/sqlite-fixtures/generate.mjs <git-ref> tests/fixtures/sqlite/<fixture-name>.db
```

The generator creates a temporary git worktree, appends the fixed events in `tests/fixtures/sqlite/events.json`, checkpoints the database and removes the worktree. After regenerating a fixture, update its ref, SHA-256 and row count in `tests/fixtures/sqlite/manifest.json`. Keep fixture files small, and never use real customer or user data.

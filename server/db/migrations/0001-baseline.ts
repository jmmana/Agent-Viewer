import type { Migration } from '../migrations';

export const baseline: Migration = {
  version: 1,
  name: 'baseline',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        runtime_id TEXT,
        session_id TEXT,
        agent_id TEXT,
        task_id TEXT,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        event_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_runtime ON events(runtime_id);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

      CREATE TABLE IF NOT EXISTS runtimes (
        id TEXT PRIMARY KEY,
        name TEXT,
        framework TEXT,
        version TEXT,
        metadata TEXT,
        status TEXT,
        first_seen_at INTEGER,
        last_seen_at INTEGER,
        events_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        runtime_id TEXT,
        name TEXT,
        created_at INTEGER,
        last_active_at INTEGER,
        status TEXT,
        events_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role_title TEXT,
        role TEXT,
        provider TEXT,
        model TEXT,
        status TEXT,
        status_text TEXT,
        workspace TEXT,
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        last_seen_at INTEGER
      );
    `);

    const columns = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === 'event_json')) {
      db.exec('ALTER TABLE events ADD COLUMN event_json TEXT');
    }
  },
};

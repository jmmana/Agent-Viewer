# Local session persistence

Agent Viewer stores a versioned local snapshot in the browser so a refresh can restore the latest compatible simulation state.

## What is persisted

- agents
- tasks
- meetings
- event history
- token and cost totals
- room reservations
- social activities
- coffee-seat assignments

Transient interface state such as open modals, selected tabs and camera position is intentionally not persisted.

## Compatibility

Snapshots are wrapped in a schema version. Corrupted JSON or snapshots from an unsupported schema version are ignored and the application falls back to a fresh simulation.

## Reset

Resetting the demo clears the stored snapshot and recreates the default local simulation.

No backend or cloud storage is used by this feature.

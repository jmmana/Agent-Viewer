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

## Live mode

Everything above describes the demo (`npm run dev`), not live mode (`?mode=live` or `VITE_AGENT_VIEWER_MODE=live`). Live mode never reads or writes this local snapshot. On open it restores the office, the recent activity and the token/cost figures from the server itself: `GET /api/v1/snapshot` and, when there is more to show than the snapshot's own newest 100 events, a page of `GET /api/v1/events?beforeId=...` (issue #72, `src/integrations/historyLoader.ts`), bounded by `VITE_AGENT_VIEWER_HISTORY_LIMIT`. Only after that does it subscribe to `GET /api/v1/events/stream`. A reload and a second tab opened mid-run both end up showing the same figures, because both load the same server record instead of starting from an empty office that waits for new events.

The only thing live mode keeps in the browser is the live API token itself, in `sessionStorage` (added in 0.3.0, see [`liveConnection.ts`](../src/integrations/liveConnection.ts)), so a reload does not need the token back in the address bar.

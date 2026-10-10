/**
 * Loads the live portal's history before it subscribes to the stream (issue #72): the server's own record,
 * instead of an empty office that waits for new events. A reload, or a second tab opened mid-run, otherwise
 * starts every figure at `0` even though the server already stored everything.
 *
 * The snapshot (`GET /api/v1/snapshot`) is the hard requirement: it carries the roster, task and meeting state
 * and the newest 100 events, and its own totals are what `rebuildFromSnapshot` (issue #54) already uses to
 * rebuild the office without summing anything in the browser. This module reuses that exact path and only adds
 * one thing: paging further back with `GET /api/v1/events?beforeId=...` (also issue #72) so the activity
 * timeline can go deeper than the snapshot's 100 events, bounded by `maxEvents`. Figures never depend on this
 * extra depth; a failure while paging for it stops paging and keeps whatever was already loaded instead of
 * failing the whole load.
 */
import { rebuildFromSnapshot, type LiveSnapshot } from './snapshotRebuild';
import type { SimulationState } from '../engine/officeState';

/** Default and bounds for `VITE_AGENT_VIEWER_HISTORY_LIMIT` (issue #72). */
export const DEFAULT_HISTORY_LIMIT = 1000;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 5000;

/**
 * Parses `VITE_AGENT_VIEWER_HISTORY_LIMIT`: an integer in `[1, 5000]`. Anything else (absent, not a number, out
 * of range, not an integer) falls back to the default of `1000`, the browser state cap `eventIngestion.ts`
 * already enforces.
 */
export function parseHistoryLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HISTORY_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_HISTORY_LIMIT;
  if (parsed < MIN_HISTORY_LIMIT || parsed > MAX_HISTORY_LIMIT) return DEFAULT_HISTORY_LIMIT;
  return parsed;
}

export interface LoadLiveHistoryOptions {
  /** Sent as `Authorization: Bearer <token>` on every request, like the resync snapshot reload already does. */
  token?: string;
  /** Locale for the texts the office writes itself while replaying history. */
  locale?: string;
  /** Upper bound of events loaded, snapshot and paged pages together. Defaults to `DEFAULT_HISTORY_LIMIT`. */
  maxEvents?: number;
  signal?: AbortSignal;
  /** `fetch` implementation. Defaults to the global `fetch`; tests pass a mock. */
  fetch?: typeof fetch;
  /** Clock for the replay of `snapshot.events`. Defaults to `Date.now()`; tests pass their own. */
  now?: number;
  /** Events fetched per `beforeId` page while paging deeper than the snapshot. Defaults to 200. */
  pageSize?: number;
}

export interface LoadLiveHistoryResult {
  state: SimulationState;
  /** Newest event actually received, from the snapshot. `null` when the store is empty. */
  lastEventId: string | null;
}

interface EventsPageResponse {
  events?: unknown[];
  hasMore?: boolean;
  nextBeforeId?: string | null;
}

function eventId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  signal: AbortSignal | undefined
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with status ${response.status}`);
  }
  return response.json();
}

/**
 * Pages backward from the oldest event the snapshot carried, collecting up to `remaining` additional, older
 * events for the activity timeline. Stops, without throwing, on the first failed page (for example a `400
 * invalid_cursor`, when the cursor event was evicted from a memory store, or an old server with no `beforeId`
 * support), an empty page, or `hasMore: false`/missing (also an old server).
 */
async function loadPriorEvents(
  apiBase: string,
  startCursor: string,
  remaining: number,
  options: Pick<LoadLiveHistoryOptions, 'token' | 'signal' | 'fetch' | 'pageSize'>
): Promise<unknown[]> {
  const fetchImpl = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? 200;
  const collected: unknown[] = [];
  let cursor: string | undefined = startCursor;

  while (remaining > 0 && cursor) {
    const limit = Math.min(pageSize, remaining);
    const url = `${apiBase}/api/v1/events?limit=${limit}&beforeId=${encodeURIComponent(cursor)}`;
    let page: EventsPageResponse;
    try {
      page = (await fetchJson(fetchImpl, url, options.token, options.signal)) as EventsPageResponse;
    } catch {
      break;
    }
    const events = Array.isArray(page.events) ? page.events : [];
    if (events.length === 0) break;
    collected.push(...events);
    remaining -= events.length;
    // An old server without `beforeId` support ignores the parameter and never returns `hasMore`: stop here
    // instead of refetching the same page forever.
    if (page.hasMore !== true) break;
    cursor = typeof page.nextBeforeId === 'string' ? page.nextBeforeId : undefined;
  }

  return collected;
}

/**
 * Loads the snapshot and, when the store holds more than the snapshot's own 100 events, pages further back for
 * the activity timeline up to `maxEvents`. A snapshot failure propagates: the caller shows an error and retries,
 * since the portal must never present a partial history as complete without one.
 */
export async function loadLiveHistory(apiBase: string, options: LoadLiveHistoryOptions = {}): Promise<LoadLiveHistoryResult> {
  const cleanBase = apiBase.replace(/\/$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const maxEvents = options.maxEvents ?? DEFAULT_HISTORY_LIMIT;

  const snapshot = (await fetchJson(
    fetchImpl,
    `${cleanBase}/api/v1/snapshot`,
    options.token,
    options.signal
  )) as LiveSnapshot;

  const snapshotEvents = Array.isArray(snapshot.events) ? snapshot.events : [];
  const oldestInSnapshot = snapshotEvents.length > 0 ? eventId(snapshotEvents[snapshotEvents.length - 1]) : undefined;
  const remaining = maxEvents - snapshotEvents.length;

  const priorEvents =
    oldestInSnapshot && remaining > 0
      ? await loadPriorEvents(cleanBase, oldestInSnapshot, remaining, {
          token: options.token,
          signal: options.signal,
          fetch: fetchImpl,
          pageSize: options.pageSize,
        })
      : [];

  const state = rebuildFromSnapshot(snapshot, { locale: options.locale, now: options.now, priorEvents });
  return { state, lastEventId: snapshot.lastEventId ?? null };
}

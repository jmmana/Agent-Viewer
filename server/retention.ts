/**
 * The retention baseline (issue #70): config parsing for the three `AGENT_VIEWER_RETENTION_*` variables, and the
 * scheduled purge job built on top of `EventStore.purge`/`recordRetentionRun`/`finishRetentionRun`
 * (`server/store.ts`). All SQL lives in the store; this module only decides *when* to purge and *what cutoff* to
 * use, and formats the one log line a run produces.
 *
 * This is the honest baseline, not the tamper-evident version: an operator with database access can still delete
 * or edit rows silently, and `retention_runs`/`retention_state` are ordinary tables with no hash chain. That is
 * deliberately a 0.8.0 concern (issues #105, #106, #109, #110); see `docs/retention.md`.
 */
import type { EventStore, RetentionRunPatch, RetentionRunRecord, RetentionTrigger } from './store';

const MAX_WINDOW_DAYS = 36500;
const MS_PER_DAY = 86_400_000;
const DEFAULT_INTERVAL_MINUTES = 60;
/** How long after `startRetention` the first ('startup') run fires. The issue's own default. */
export const DEFAULT_STARTUP_DELAY_MS = 30_000;

export interface RetentionConfig {
  /** `AGENT_VIEWER_RETENTION_DAYS`. `null` means keep every event forever. */
  eventsDays: number | null;
  /** `AGENT_VIEWER_USAGE_RETENTION_DAYS`. `null` means keep every ledger row forever (the default). */
  ledgerDays: number | null;
  /** `AGENT_VIEWER_RETENTION_INTERVAL_MINUTES`, 1 to 1440. Default 60. */
  intervalMinutes: number;
}

/** Only digits, no leading zero, 1 to 5 of them (so up to `99999`; the explicit `<= MAX_WINDOW_DAYS` check below
 * is what actually rejects anything over 36500, with the same error message as a non-numeric value). */
const WINDOW_PATTERN = /^[1-9][0-9]{0,4}$/;
const POSITIVE_INT_PATTERN = /^[1-9][0-9]*$/;

function parseWindowDays(raw: string | undefined, varName: string): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!WINDOW_PATTERN.test(trimmed) || value > MAX_WINDOW_DAYS) {
    throw new Error(`[agent-viewer] ${varName} must be an integer from 1 to ${MAX_WINDOW_DAYS} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function parseIntervalMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MINUTES;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!POSITIVE_INT_PATTERN.test(trimmed) || value > 1440) {
    throw new Error(
      `[agent-viewer] AGENT_VIEWER_RETENTION_INTERVAL_MINUTES must be an integer from 1 to 1440 (got ${JSON.stringify(raw)})`
    );
  }
  return value;
}

/**
 * Parses the three retention variables. Pure and env-free beyond its argument (same shape as `parseMaxEvents` in
 * `server/store.ts`), so a test can exercise every case without importing the server. Unset, empty or
 * whitespace-only means "keep" for a window, or the default for the interval; anything else that is not a plain
 * positive integer in range throws, naming the variable and the accepted range, so a typo at startup is never
 * silently ignored or misread as "disabled" (see the module doc comment and issue #70's own rationale for
 * rejecting `0` outright instead of treating it as either reading).
 */
export function parseRetentionConfig(env: Record<string, string | undefined>): RetentionConfig {
  return {
    eventsDays: parseWindowDays(env.AGENT_VIEWER_RETENTION_DAYS, 'AGENT_VIEWER_RETENTION_DAYS'),
    ledgerDays: parseWindowDays(env.AGENT_VIEWER_USAGE_RETENTION_DAYS, 'AGENT_VIEWER_USAGE_RETENTION_DAYS'),
    intervalMinutes: parseIntervalMinutes(env.AGENT_VIEWER_RETENTION_INTERVAL_MINUTES),
  };
}

/** The one-line startup warning for an enabled ledger window. Its own function so a test can check the exact
 * text without capturing `console.log`. */
export function usageRetentionWarning(days: number): string {
  return `[agent-viewer] usage ledger retention is enabled (${days} days): consumption rows older than that are deleted for good`;
}

/** Short, content-free description of a thrown error: its `code` (if any) plus its message, truncated to 200
 * characters. Never includes row contents, ids or summaries (issue #70's own rule for the audit log). */
function describeError(error: unknown): string {
  const err = error as { code?: string; message?: string } | null;
  const text = err?.code ? `${err.code}: ${err?.message ?? ''}` : error instanceof Error ? error.message : String(error);
  return text.slice(0, 200);
}

function isoOrNull(ms: number | null): string {
  return ms === null ? 'unknown' : new Date(ms).toISOString();
}

export interface RetentionJobOptions {
  store: EventStore;
  config: RetentionConfig;
  /** Server clock, injected for tests. Default `Date.now`. */
  now?: () => number;
  /** One line per non-skipped run (issue #70's required log shape). Default `console.log`. */
  log?: (message: string) => void;
  /** Delay before the first ('startup') run. Default `DEFAULT_STARTUP_DELAY_MS`; tests override it. */
  startupDelayMs?: number;
}

export interface RetentionJobHandle {
  /** Stops the timers and waits for a run already in progress, then resolves. Safe to call more than once. */
  stop(): Promise<void>;
  /** Runs one purge attempt now, honoring the overlap guard like a timer-driven tick would. Exposed mainly for
   * tests; the job itself calls this on its own schedule. */
  runOnce(trigger: RetentionTrigger): Promise<RetentionRunRecord>;
  /** Rows deleted by this job since the process started, per scope. `null` when that scope's window is not
   * configured (see `totalDeletedSinceStart` in `GET /api/v1/admin/retention`), never a stand-in `0`. */
  totals(): { events: number | null; usageLedger: number | null };
}

/**
 * Starts the scheduled purge job (issue #70). With both `config.eventsDays` and `config.ledgerDays` unset, no
 * timer is created at all: the returned handle's `runOnce` still works (useful for tests and for the one
 * `'startup'` call a caller might want to force), but nothing calls it on its own, so an unconfigured server is
 * fully inert. Otherwise runs once after `startupDelayMs` (default 30s), then every `config.intervalMinutes`,
 * through `setInterval(...).unref()` (and the startup `setTimeout`, also unref'd) so neither timer ever holds the
 * process open by itself.
 *
 * Overlap guard: while one run is in flight, a concurrent `runOnce` call (from the other timer, or a caller)
 * records and immediately finishes a `'skipped'` run instead of running a second purge at the same time.
 */
export function startRetention(opts: RetentionJobOptions): RetentionJobHandle {
  const { store, config } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((message: string) => console.log(message));
  const startupDelayMs = opts.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;

  let running = false;
  let inFlight: Promise<RetentionRunRecord> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  // Per-process totals (issue #70's `totalDeletedSinceStart`): `null` when that scope's window is never
  // configured for this process, so it is never confused with a real `0` (a job that ran and deleted nothing).
  let eventsTotalSinceStart: number | null = config.eventsDays !== null ? 0 : null;
  let ledgerTotalSinceStart: number | null = config.ledgerDays !== null ? 0 : null;

  async function recordSkip(trigger: RetentionTrigger): Promise<RetentionRunRecord> {
    const startedAt = now();
    const id = await store.recordRetentionRun({ startedAt, trigger, skip: true });
    log('[agent-viewer] retention: skipped (a run was already in progress)');
    return {
      id,
      startedAt,
      finishedAt: startedAt,
      trigger,
      status: 'skipped',
      eventsWindowDays: config.eventsDays,
      eventsCutoffMs: null,
      eventsDeleted: 0,
      ledgerWindowDays: config.ledgerDays,
      ledgerCutoffMs: null,
      ledgerDeleted: 0,
      error: null,
    };
  }

  async function runNow(trigger: RetentionTrigger): Promise<RetentionRunRecord> {
    const startedAt = now();
    const id = await store.recordRetentionRun({ startedAt, trigger });
    const eventsCutoffMs = config.eventsDays !== null ? startedAt - config.eventsDays * MS_PER_DAY : null;
    const ledgerCutoffMs = config.ledgerDays !== null ? startedAt - config.ledgerDays * MS_PER_DAY : null;

    let patch: RetentionRunPatch;
    try {
      const result = await store.purge({
        eventsCutoffMs: eventsCutoffMs ?? undefined,
        ledgerCutoffMs: ledgerCutoffMs ?? undefined,
      });
      patch = {
        finishedAt: now(),
        status: 'ok',
        eventsWindowDays: config.eventsDays,
        eventsCutoffMs,
        eventsDeleted: result.eventsDeleted,
        ledgerWindowDays: config.ledgerDays,
        ledgerCutoffMs,
        ledgerDeleted: result.ledgerDeleted,
        error: null,
      };
      const eventsText =
        config.eventsDays === null
          ? 'events: kept (no window)'
          : `deleted ${result.eventsDeleted} events older than ${config.eventsDays} days (cutoff ${isoOrNull(eventsCutoffMs)})`;
      const ledgerText =
        config.ledgerDays === null
          ? 'usage ledger: kept (no window)'
          : `usage ledger: deleted ${result.ledgerDeleted} rows older than ${config.ledgerDays} days (cutoff ${isoOrNull(ledgerCutoffMs)})`;
      log(`[agent-viewer] retention: ${eventsText}; ${ledgerText}`);
    } catch (error) {
      // Never crashes the server (issue #70): logged and recorded as 'error', the next tick tries again.
      const message = describeError(error);
      patch = {
        finishedAt: now(),
        status: 'error',
        eventsWindowDays: config.eventsDays,
        eventsCutoffMs,
        eventsDeleted: 0,
        ledgerWindowDays: config.ledgerDays,
        ledgerCutoffMs,
        ledgerDeleted: 0,
        error: message,
      };
      log(`[agent-viewer] retention: run failed: ${message}`);
    }
    await store.finishRetentionRun(id, patch);
    if (eventsTotalSinceStart !== null) eventsTotalSinceStart += patch.eventsDeleted;
    if (ledgerTotalSinceStart !== null) ledgerTotalSinceStart += patch.ledgerDeleted;
    return { id, startedAt, trigger, ...patch };
  }

  async function runOnce(trigger: RetentionTrigger): Promise<RetentionRunRecord> {
    if (running) return recordSkip(trigger);
    running = true;
    const run = runNow(trigger).finally(() => {
      running = false;
      inFlight = null;
    });
    inFlight = run;
    return run;
  }

  if (config.eventsDays !== null || config.ledgerDays !== null) {
    startupTimer = setTimeout(() => {
      void runOnce('startup');
    }, startupDelayMs);
    startupTimer.unref?.();
    intervalTimer = setInterval(() => {
      void runOnce('schedule');
    }, config.intervalMinutes * 60_000);
    intervalTimer.unref?.();
  }

  return {
    runOnce,
    async stop() {
      if (startupTimer) clearTimeout(startupTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      if (inFlight) await inFlight.catch(() => {});
    },
    totals() {
      return { events: eventsTotalSinceStart, usageLedger: ledgerTotalSinceStart };
    },
  };
}

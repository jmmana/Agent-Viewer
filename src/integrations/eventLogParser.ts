import { validateCanonicalEvent, type CanonicalEvent } from './canonicalContract';
import { mapOtlpLogsRequest, type OtlpExportLogsServiceRequest } from './otlp/claudeCodeLogs';

export const MAX_EVENT_LOG_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

/** Per-request-record issue cap (issue #74): past this many, the rest are only counted, not listed. */
const MAX_OTLP_RECORD_ISSUES = 50;

/**
 * Passed as `now` to the shared #59 mapper so its last-resort "no reported time, use receive time" fallback
 * (correct for a live HTTP push, see `server/index.ts`) can never fire here: a file has no receive time, only
 * a read time, and the contract requires a positive timestamp, so a record that resolves to this negative
 * sentinel fails `validateCanonicalEvent` and is rejected as `otlp-record-skipped` instead of silently getting
 * the moment the file happened to be opened (issue #74, section 2: "the parser never substitutes the current
 * time").
 */
const NO_RECEIVE_TIME_SENTINEL_MS = -1;

const OTLP_TRACES_MESSAGE = 'OTLP traces are not supported yet. Export the run as canonical JSONL V1.';
const OTLP_METRICS_MESSAGE =
  'OTLP metrics are pre-aggregated counters and cannot be replayed as individual calls. Export the logs signal (resourceLogs) to replay usage, or send metrics to the server.';
const OTLP_NO_USAGE_MESSAGE =
  'The OTLP logs file was read, but no record mapped to a usable call (llm.usage or llm.failed). Check that telemetry was enabled for a Claude Code run.';

export type EventLogIssueCode =
  | 'invalid-json'
  | 'invalid-event'
  | 'otlp-metrics-not-replayable'
  | 'otlp-traces-not-supported'
  | 'otlp-record-skipped'
  | 'otlp-no-usage-records';

export interface EventLogParseIssue {
  /** Physical line; `1` for a pretty-printed single document. */
  line: number;
  /** Never set for an OTLP issue: a log record can carry sensitive text. */
  raw?: string;
  error: string;
  /** Machine-readable reason, set on every issue this parser emits. */
  code?: EventLogIssueCode;
  /** OTLP only, relative to the request object, e.g. `resourceLogs[0].scopeLogs[1].logRecords[3]`. */
  path?: string;
}

export interface EventLogOtlpSummary {
  /** In this fixed order, only the signals actually found in the file. */
  signals: Array<'logs' | 'metrics' | 'traces'>;
  /** Log records seen across every `resourceLogs` request found. */
  logRecords: number;
  /** Records mapped to a canonical event. */
  converted: number;
  /** Records the mapper answered `ignored` for (not an error). */
  skipped: number;
  /** Records reported through an `otlp-record-skipped` issue (or counted past the cap). */
  rejected: number;
}

export interface EventLogParseResult {
  events: CanonicalEvent[];
  issues: EventLogParseIssue[];
  totalLines: number;
  format: 'jsonl' | 'otlp';
  /** Present only when `format === 'otlp'`. `logRecords === converted + skipped + rejected` always holds. */
  otlp?: EventLogOtlpSummary;
}

/** Shape shared by the three OTLP export request bodies this parser recognizes. */
interface OtlpSignalsFound {
  logs?: unknown[];
  metrics?: unknown[];
  traces?: unknown[];
}

/**
 * Classifies a parsed JSON value as an OTLP export request by structure, never by searching the raw text for a
 * substring (issue #74): an object counts only when at least one of `resourceLogs`, `resourceMetrics`,
 * `resourceSpans` is itself an array. Anything else (including an object with one of those keys set to a
 * non-array value) is not an OTLP request.
 */
function detectOtlpSignals(value: unknown): OtlpSignalsFound | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const logs = Array.isArray(obj.resourceLogs) ? obj.resourceLogs : undefined;
  const metrics = Array.isArray(obj.resourceMetrics) ? obj.resourceMetrics : undefined;
  const traces = Array.isArray(obj.resourceSpans) ? obj.resourceSpans : undefined;
  if (!logs && !metrics && !traces) return null;
  return { logs, metrics, traces };
}

interface OtlpRequestEntry {
  lineNumber: number;
  signals: OtlpSignalsFound;
}

/**
 * Runs every OTLP logs request found in the file through the shared #59 mapper (no second mapping
 * implementation, per issue #74), then folds the results, the fixed metrics/traces issues and the per-record
 * `otlp-record-skipped` issues (capped at `MAX_OTLP_RECORD_ISSUES`) into one result.
 */
function buildOtlpResult(
  requests: OtlpRequestEntry[],
  totalLines: number,
  canonicalEvents: CanonicalEvent[],
  canonicalIssues: EventLogParseIssue[],
): EventLogParseResult {
  const events: CanonicalEvent[] = [...canonicalEvents];
  const issues: EventLogParseIssue[] = [...canonicalIssues];

  let firstMetricsLine: number | null = null;
  let firstTracesLine: number | null = null;
  let firstLogsLine: number | null = null;

  let logRecords = 0;
  let converted = 0;
  let skipped = 0;
  let rejected = 0;
  const perRecordReasons: Array<{ line: number; error: string }> = [];

  for (const request of requests) {
    if (request.signals.metrics && firstMetricsLine === null) firstMetricsLine = request.lineNumber;
    if (request.signals.traces && firstTracesLine === null) firstTracesLine = request.lineNumber;

    if (request.signals.logs) {
      if (firstLogsLine === null) firstLogsLine = request.lineNumber;
      const mapped = mapOtlpLogsRequest(
        { resourceLogs: request.signals.logs } as OtlpExportLogsServiceRequest,
        { now: NO_RECEIVE_TIME_SENTINEL_MS },
      );
      logRecords += mapped.stats.received;
      converted += mapped.events.length;
      skipped += mapped.stats.ignored + mapped.stats.unknown;
      rejected += mapped.stats.unattributed + mapped.stats.invalid;
      events.push(...mapped.events);
      for (const reason of mapped.rejectionReasons) {
        perRecordReasons.push({ line: request.lineNumber, error: reason });
      }
    }
  }

  if (firstMetricsLine !== null) {
    issues.push({ line: firstMetricsLine, error: OTLP_METRICS_MESSAGE, code: 'otlp-metrics-not-replayable' });
  }
  if (firstTracesLine !== null) {
    issues.push({ line: firstTracesLine, error: OTLP_TRACES_MESSAGE, code: 'otlp-traces-not-supported' });
  }

  const listed = perRecordReasons.slice(0, MAX_OTLP_RECORD_ISSUES);
  for (const { line, error } of listed) {
    issues.push({ line, error, code: 'otlp-record-skipped' });
  }
  const overflow = perRecordReasons.length - listed.length;
  if (overflow > 0) {
    const lastLine = perRecordReasons[perRecordReasons.length - 1]?.line ?? firstLogsLine ?? 1;
    issues.push({
      line: lastLine,
      error: `${overflow} more record${overflow === 1 ? '' : 's'} were rejected and are not listed individually.`,
      code: 'otlp-record-skipped',
    });
  }

  if (firstLogsLine !== null && logRecords > 0 && converted === 0) {
    issues.push({ line: firstLogsLine, error: OTLP_NO_USAGE_MESSAGE, code: 'otlp-no-usage-records' });
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  const signals: Array<'logs' | 'metrics' | 'traces'> = [];
  if (firstLogsLine !== null) signals.push('logs');
  if (firstMetricsLine !== null) signals.push('metrics');
  if (firstTracesLine !== null) signals.push('traces');

  return {
    events,
    issues,
    totalLines,
    format: 'otlp',
    otlp: { signals, logRecords, converted, skipped, rejected },
  };
}

/**
 * Parses a Canonical JSONL V1 file or text string into validated CanonicalEvent objects. OTLP logs files are
 * converted through the shared Claude Code mapper (issue #59); OTLP metrics and traces files are reported with
 * a clear issue instead of being silently dropped or misread as JSONL (issue #74). Invalid lines are captured
 * in `issues` without aborting the entire parse.
 */
export async function parseEventLog(
  input: string | File | Blob
): Promise<EventLogParseResult> {
  let content = '';

  if (typeof input === 'string') {
    content = input;
  } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > MAX_EVENT_LOG_SIZE_BYTES) {
      throw new Error(
        `File exceeds maximum allowed size of ${MAX_EVENT_LOG_SIZE_BYTES / (1024 * 1024)} MB (size: ${(input.size / (1024 * 1024)).toFixed(2)} MB)`
      );
    }
    content = await input.text();
  } else {
    throw new Error('Unsupported input type for parseEventLog');
  }

  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > MAX_EVENT_LOG_SIZE_BYTES) {
    throw new Error(
      `Payload exceeds maximum allowed size of ${MAX_EVENT_LOG_SIZE_BYTES / (1024 * 1024)} MB (size: ${(byteLength / (1024 * 1024)).toFixed(2)} MB)`
    );
  }

  const trimmed = content.trim();
  const lines = content.split(/\r?\n/);

  // 1. Try the whole trimmed content as one JSON document first: covers a pretty-printed OTLP export and a
  // single-object canonical file. This replaces the old `includes('"resourceSpans"')` substring test, which
  // misrouted a canonical line whose `summary` happened to contain that text.
  let wholeDocument: unknown;
  let wholeParseOk = true;
  try {
    wholeDocument = JSON.parse(trimmed);
  } catch {
    wholeParseOk = false;
  }

  if (wholeParseOk) {
    const signals = detectOtlpSignals(wholeDocument);
    if (signals) {
      return buildOtlpResult([{ lineNumber: 1, signals }], lines.length, [], []);
    }
    const validation = validateCanonicalEvent(wholeDocument);
    if (validation.success && validation.data) {
      return { events: [validation.data], issues: [], totalLines: lines.length, format: 'jsonl' };
    }
    return {
      events: [],
      issues: [
        {
          line: 1,
          raw: trimmed.slice(0, 100),
          error: validation.issues?.map((i) => i.message).join('; ') || 'Contract validation failed',
          code: 'invalid-event',
        },
      ],
      totalLines: lines.length,
      format: 'jsonl',
    };
  }

  // 2. The whole document failed to parse. A truncated pretty-printed export (for example a Collector `file`
  // exporter export cut off mid-write) starts with a lone `{` on its own line: report that once, without
  // echoing the rest of the file one "Malformed JSON" issue per physical line (issue #74, section 1.4).
  const firstNonBlankLine = lines.find((line) => line.trim() !== '');
  if (firstNonBlankLine !== undefined && firstNonBlankLine.trim() === '{') {
    return {
      events: [],
      issues: [
        {
          line: 1,
          error: 'Malformed JSON: the file could not be parsed as one JSON document.',
          code: 'invalid-json',
        },
      ],
      totalLines: lines.length,
      format: 'jsonl',
    };
  }

  // 3. Otherwise, parse and classify every physical line independently: a Collector `file` exporter writes one
  // OTLP request object per line, and those can sit next to canonical JSONL lines in the same file.
  const events: CanonicalEvent[] = [];
  const issues: EventLogParseIssue[] = [];
  const otlpRequests: OtlpRequestEntry[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx].trim();
    if (!rawLine) continue; // Skip empty lines

    let json: unknown;
    try {
      json = JSON.parse(rawLine);
    } catch (err: any) {
      issues.push({
        line: idx + 1,
        raw: rawLine.slice(0, 100),
        error: `Malformed JSON: ${err?.message || 'Syntax error'}`,
        code: 'invalid-json',
      });
      continue;
    }

    const signals = detectOtlpSignals(json);
    if (signals) {
      otlpRequests.push({ lineNumber: idx + 1, signals });
      continue;
    }

    const validation = validateCanonicalEvent(json);
    if (validation.success && validation.data) {
      events.push(validation.data);
    } else {
      issues.push({
        line: idx + 1,
        raw: rawLine.slice(0, 100),
        error: validation.issues?.map((i) => i.message).join('; ') || 'Contract validation failed',
        code: 'invalid-event',
      });
    }
  }

  if (otlpRequests.length === 0) {
    // Sort events chronologically ascending
    events.sort((a, b) => a.timestamp - b.timestamp);
    return {
      events,
      issues,
      totalLines: lines.length,
      format: 'jsonl',
    };
  }

  return buildOtlpResult(otlpRequests, lines.length, events, issues);
}

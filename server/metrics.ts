/**
 * Minimal Prometheus text-exposition writer for `GET /metrics` (issue #103, first sub-issue). No `prom-client`,
 * no runtime dependency, about 100 lines: a label sanitizer/escaper and a renderer for the text format 0.0.4.
 *
 * This slice ships only the in-process families `server/index.ts` can compute without a ledger query:
 * `agent_viewer_build_info` and `agent_viewer_sse_clients`. The ledger-derived families (tokens, cost, calls,
 * failures, latency) and the cardinality cap they need are a later sub-issue of #103, tracked separately so the
 * endpoint, its auth model and its opt-in/rate-limit plumbing can ship and be reviewed on their own first. See
 * `docs/metrics.md` (added by that later sub-issue) for the full catalog; this module intentionally has no
 * histogram or counter-accumulation support yet, since nothing in this slice needs one.
 */

export type MetricType = 'counter' | 'gauge';

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

const MAX_LABEL_VALUE_LENGTH = 100;

/**
 * Label hygiene (issue #103): strips control characters and caps length at 100 characters. Every label value
 * this module ever writes goes through this first, so two values that collapse to the same sanitized string
 * would merge in the caller's own grouping, never silently overwrite one another here.
 */
export function sanitizeLabelValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping C0/DEL control characters from a label value
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, '');
  return stripped.length > MAX_LABEL_VALUE_LENGTH ? stripped.slice(0, MAX_LABEL_VALUE_LENGTH) : stripped;
}

/** Escapes a label value for the text exposition format: backslash, then double quote, then newline, in that
 * order (escaping backslash first so the backslashes introduced by the later two steps are never re-escaped). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Plain decimal, up to 10 fractional digits, trailing zeros trimmed, no exponent (issue #103's number format
 * rule). Non-finite values are never produced by a caller in this codebase; this still never writes one. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return `{${keys.map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`).join(',')}}`;
}

function writeFamily(lines: string[], family: MetricFamily): void {
  lines.push(`# HELP ${family.name} ${family.help}`);
  lines.push(`# TYPE ${family.name} ${family.type}`);
  for (const sample of family.samples) {
    lines.push(`${family.name}${formatLabels(sample.labels)} ${formatNumber(sample.value)}`);
  }
}

/**
 * Renders every family to the final response body: `# HELP`/`# TYPE` plus each sample, in the order given, one
 * series line per sample. A family with zero samples still gets its `HELP`/`TYPE` lines, same as a Prometheus
 * client library's registered-but-unobserved metric. Ends with a trailing newline, per the exposition format;
 * returns `''` (no trailing newline) when there are no families at all.
 */
export function renderExposition(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) writeFamily(lines, family);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface InProcessMetricsInput {
  version: string;
  storage: 'memory' | 'sqlite';
  sseClients: number;
}

/**
 * The two in-process families this sub-issue ships. Both are computed fresh at scrape time from state
 * `server/index.ts` already keeps (`SERVER_VERSION`, `store.readiness().storage`, `clients.size`), never cached
 * and never reset except by a process restart.
 */
export function buildInProcessFamilies(input: InProcessMetricsInput): MetricFamily[] {
  return [
    {
      name: 'agent_viewer_build_info',
      help: 'Server version and storage mode. Value is always 1; the facts are in the labels.',
      type: 'gauge',
      samples: [
        {
          labels: { version: sanitizeLabelValue(input.version), storage: input.storage },
          value: 1,
        },
      ],
    },
    {
      name: 'agent_viewer_sse_clients',
      help: 'Open Server-Sent Events stream connections.',
      type: 'gauge',
      samples: [{ labels: {}, value: input.sseClients }],
    },
  ];
}

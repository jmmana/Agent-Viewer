/**
 * Shared between the Claude Code telemetry installer (`cli/claudeInstall.ts`, issue #60) and the OTLP/HTTP logs
 * receiver that issue #59 adds to the server. Both sides must agree on the path: the installer writes it into
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, and the server answers on it. When #59 lands, it should import this same
 * constant instead of hard-coding the path a second time.
 */
export const OTLP_LOGS_PATH = '/v1/logs';

/**
 * Same role as `OTLP_LOGS_PATH`, for OTLP metrics (issue #73): Claude Code's OTLP exporter posts to
 * `OTEL_EXPORTER_OTLP_ENDPOINT` + this path when `OTEL_METRICS_EXPORTER=otlp` is set. Wiring that env var into
 * `install claude-code --telemetry` is a follow-up to issue #60, not this constant's concern.
 */
export const OTLP_METRICS_PATH = '/v1/metrics';

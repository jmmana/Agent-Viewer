/**
 * Shared between the Claude Code telemetry installer (`cli/claudeInstall.ts`, issue #60) and the OTLP/HTTP logs
 * receiver that issue #59 adds to the server. Both sides must agree on the path: the installer writes it into
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, and the server answers on it. When #59 lands, it should import this same
 * constant instead of hard-coding the path a second time.
 */
export const OTLP_LOGS_PATH = '/v1/logs';

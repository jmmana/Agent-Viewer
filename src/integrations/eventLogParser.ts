import { validateCanonicalEvent, type CanonicalEvent } from './canonicalContract';

export const MAX_EVENT_LOG_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface EventLogParseIssue {
  line: number;
  raw?: string;
  error: string;
}

export interface EventLogParseResult {
  events: CanonicalEvent[];
  issues: EventLogParseIssue[];
  totalLines: number;
  format: 'jsonl' | 'otlp';
}

/**
 * Parses a Canonical JSONL V1 file or text string into validated CanonicalEvent objects.
 * Also detects and converts OTLP JSON traces if present.
 * Invalid lines are captured in `issues` without aborting the entire parse.
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

  // 1. Detect OTLP JSON format
  if (trimmed.startsWith('{') && trimmed.includes('"resourceSpans"')) {
    try {
      const parsedOtlp = JSON.parse(trimmed);
      const { fromOtlpJson } = await import('./otel/index');
      const otlpResult = fromOtlpJson(parsedOtlp);
      return {
        events: otlpResult.events,
        issues: otlpResult.issues.map((msg, i) => ({ line: i + 1, error: msg })),
        totalLines: 1,
        format: 'otlp',
      };
    } catch (err: any) {
      return {
        events: [],
        issues: [{ line: 1, error: `Invalid OTLP JSON: ${err?.message || 'Parse error'}` }],
        totalLines: 1,
        format: 'otlp',
      };
    }
  }

  // 2. Parse Canonical JSONL V1 format (one JSON object per line)
  const lines = content.split(/\r?\n/);
  const events: CanonicalEvent[] = [];
  const issues: EventLogParseIssue[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx].trim();
    if (!rawLine) continue; // Skip empty lines

    try {
      const json = JSON.parse(rawLine);
      const validation = validateCanonicalEvent(json);
      if (validation.success && validation.data) {
        events.push(validation.data);
      } else {
        issues.push({
          line: idx + 1,
          raw: rawLine.slice(0, 100),
          error: validation.issues?.map((i) => i.message).join('; ') || 'Contract validation failed',
        });
      }
    } catch (err: any) {
      issues.push({
        line: idx + 1,
        raw: rawLine.slice(0, 100),
        error: `Malformed JSON: ${err?.message || 'Syntax error'}`,
      });
    }
  }

  // Sort events chronologically ascending
  events.sort((a, b) => a.timestamp - b.timestamp);

  return {
    events,
    issues,
    totalLines: lines.length,
    format: 'jsonl',
  };
}

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
 * OTLP JSON traces are detected and reported as not supported yet.
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

  // OTLP traces are recognized but not converted yet: say so instead of failing silently.
  if (trimmed.startsWith('{') && trimmed.includes('"resourceSpans"')) {
    return {
      events: [],
      issues: [{ line: 1, error: 'OTLP traces are not supported yet. Export the run as canonical JSONL V1.' }],
      totalLines: 1,
      format: 'otlp',
    };
  }

  // Canonical JSONL V1 format (one JSON object per line) (one JSON object per line)
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

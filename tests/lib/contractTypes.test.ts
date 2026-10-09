/**
 * Type-level checks of the canonical contract. They live in a `.ts` file so `npm run lint` (tsc) checks
 * them: `.mjs` suites are not type-checked. The runtime assertions only keep Vitest from reporting an
 * empty file.
 */
import { describe, expect, it } from 'vitest';
import {
  LLM_ERROR_KINDS,
  isLlmErrorKind,
  type CanonicalEventType,
  type LlmErrorKind,
} from '../../src/lib/index';
import type { LlmFailedPayload, LlmUsagePayload } from '../../src/integrations/canonicalContract';

/** `true` only when both types are exactly the same. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Compiles only when the argument is the literal type `true`. */
function assertType<T extends true>(value: T): T {
  return value;
}

type UnknownCount = number | null | undefined;

// Unknown is never zero: every breakdown counter accepts "not reported" (absent) and "unknown" (null).
const cachedAbsent: LlmUsagePayload['cachedTokens'] = undefined;
const cachedNull: LlmUsagePayload['cachedTokens'] = null;
const reasoningAbsent: LlmUsagePayload['reasoningTokens'] = undefined;
const reasoningNull: LlmUsagePayload['reasoningTokens'] = null;
const cacheReadAbsent: LlmUsagePayload['cacheReadTokens'] = undefined;
const cacheReadNull: LlmUsagePayload['cacheReadTokens'] = null;
const cacheWriteAbsent: LlmUsagePayload['cacheWriteTokens'] = undefined;
const cacheWriteNull: LlmUsagePayload['cacheWriteTokens'] = null;

const usageCountersAreUnknownAware = [
  assertType<Equal<LlmUsagePayload['cachedTokens'], UnknownCount>>(true),
  assertType<Equal<LlmUsagePayload['reasoningTokens'], UnknownCount>>(true),
  assertType<Equal<LlmUsagePayload['cacheReadTokens'], UnknownCount>>(true),
  assertType<Equal<LlmUsagePayload['cacheWriteTokens'], UnknownCount>>(true),
];

const failedPayloadTypes = [
  assertType<Equal<LlmFailedPayload['errorKind'], LlmErrorKind>>(true),
  assertType<Equal<LlmFailedPayload['inputTokens'], UnknownCount>>(true),
  assertType<Equal<LlmFailedPayload['outputTokens'], UnknownCount>>(true),
  assertType<Equal<LlmFailedPayload['cacheReadTokens'], UnknownCount>>(true),
  assertType<Equal<LlmFailedPayload['cacheWriteTokens'], UnknownCount>>(true),
  assertType<Equal<LlmFailedPayload['reasoningTokens'], UnknownCount>>(true),
  assertType<Equal<LlmErrorKind, (typeof LLM_ERROR_KINDS)[number]>>(true),
];

const failedIsCanonical: CanonicalEventType = 'llm.failed';

describe('contract types', () => {
  it('keeps the type-level checks in the compiled test', () => {
    expect([cachedAbsent, reasoningAbsent, cacheReadAbsent, cacheWriteAbsent]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect([cachedNull, reasoningNull, cacheReadNull, cacheWriteNull]).toEqual([null, null, null, null]);
    expect(usageCountersAreUnknownAware.every(Boolean)).toBe(true);
    expect(failedPayloadTypes.every(Boolean)).toBe(true);
    expect(failedIsCanonical).toBe('llm.failed');
  });

  it('narrows an error kind with isLlmErrorKind', () => {
    const value: unknown = 'overloaded';
    if (!isLlmErrorKind(value)) throw new Error('Expected a known error kind');
    const kind: LlmErrorKind = value;
    expect(kind).toBe('overloaded');
    expect(isLlmErrorKind('billing')).toBe(false);
  });
});

/**
 * Per-call metadata of a model call, as the host knows it. Display types only: hand-written, like
 * `UsageFigures`, not Zod or contract types, and they do not touch `canonicalContract.ts`.
 *
 * The office never fetches, sums, prices, estimates or derives any of this: every value comes from the
 * host through `agentCallDetails`, and the shape is closed on purpose so a prompt, a completion or any
 * other content string cannot be passed, not even by mistake.
 */

/** Outcome of one call, as reported by the host. */
export type AgentCallStatus = 'ok' | 'failed' | 'rate_limited';

/** How the cost of this call was obtained. Mirrors the event contract's `costSource`. */
export type AgentCallCostSource = 'provider-reported' | 'estimated' | 'unknown';

export interface AgentCallTokens {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  reasoning?: number | null;
}

/** Metadata of one model call. Closed on purpose: there is no field that can carry prompt or output text. */
export interface AgentCallDetail {
  /** Opaque key chosen by the host. Used only as part of the React key. Never rendered, never put in an attribute. */
  id: string;
  provider?: string | null;
  model?: string | null;
  tokens?: AgentCallTokens;
  requestId?: string | null;
  latencyMs?: number | null;
  status?: AgentCallStatus | null;
  costSource?: AgentCallCostSource | null;
  /** Cost of this single call as the host knows it. Shown next to `costSource`; never summed. */
  cost?: number | null;
  currency?: string | null;
}

/** Calls per agent id, in the order the host wants them shown. The office does not sort or deduplicate them. */
export type AgentCallDetails = Record<string, readonly AgentCallDetail[]>;

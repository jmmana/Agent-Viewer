/**
 * Drift guard for `src/types.ts` (issue #343). Type-checked by the repository's root `npm run lint`, never
 * built nor published (`files` only ships `dist`). Each line fails `tsc` as soon as a copy and its source in
 * `server/` or `src/integrations/` disagree, so the published SDK can stay free of those imports.
 */
import type { z } from 'zod';
import type {
  CanonicalEvent as ContractCanonicalEvent,
  CanonicalEventType as ContractCanonicalEventType,
  EventSeverity as ContractEventSeverity,
  LlmFailedPayloadSchema,
  LlmUsagePayloadSchema,
} from '../../../src/integrations/canonicalContract';
import type { LlmErrorKind as ContractLlmErrorKind } from '../../../src/integrations/canonicalTypes';
import type { UsageFigures as LibUsageFigures } from '../../../src/lib/usage';
import type { ViewerSnapshot as ServerViewerSnapshot } from '../../../server/store';
import type { UsageSummary as ServerUsageSummary } from '../../../server/usageAggregates';
import type {
  CallRecord as ServerCallRecord,
  UsageRollupResponse as ServerUsageRollupResponse,
  RollupDimension as ServerRollupDimension,
  RollupSort as ServerRollupSort,
  TimeBasis as ServerTimeBasis,
} from '../../../server/usage/types';
import type { BudgetView as ServerBudgetView } from '../../../server/budgets';
import type * as Sdk from '../src/types';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type ContractDriftChecks = [
  Assert<Equal<Sdk.CanonicalEvent, ContractCanonicalEvent>>,
  Assert<Equal<Sdk.CanonicalEventType, ContractCanonicalEventType>>,
  Assert<Equal<Sdk.EventSeverity, ContractEventSeverity>>,
  Assert<Equal<Sdk.LlmErrorKind, ContractLlmErrorKind>>,
  Assert<Equal<Required<Sdk.LlmUsagePayloadInput>, Required<z.input<typeof LlmUsagePayloadSchema>>>>,
  Assert<Equal<Required<Sdk.LlmFailedPayloadInput>, Required<z.input<typeof LlmFailedPayloadSchema>>>>,
  Assert<Equal<Sdk.UsageFigures, LibUsageFigures>>,
  Assert<Equal<Sdk.ViewerSnapshot, ServerViewerSnapshot>>,
  Assert<Equal<Sdk.UsageSummary, ServerUsageSummary>>,
  Assert<Equal<Sdk.CallRecord, ServerCallRecord>>,
  Assert<Equal<Sdk.UsageRollupResponse, ServerUsageRollupResponse>>,
  Assert<Equal<Sdk.RollupDimension, ServerRollupDimension>>,
  Assert<Equal<Sdk.RollupSort, ServerRollupSort>>,
  Assert<Equal<Sdk.TimeBasis, ServerTimeBasis>>,
  Assert<Equal<Sdk.BudgetView, ServerBudgetView>>,
];

/**
 * Compile-time only (no runtime assertions, nothing is executed): guards against the `packages/sdk`
 * extraction (issue #343) silently drifting from the root canonical event contract. `npm run lint`
 * (`tsc --noEmit`) type-checks this file like any other `.ts` file in the project; a mismatch between the
 * two `CanonicalEvent` shapes fails the build here instead of surfacing as a runtime bug in a consumer.
 *
 * Checked by relative import to `packages/sdk/src/index.ts` on purpose, not by the published package name:
 * this assertion is about the two *type definitions* never drifting apart, independent of whether the
 * workspace package has been built yet.
 */
import type {
  CanonicalEvent as PackageCanonicalEvent,
  CanonicalEventType as PackageCanonicalEventType,
  EventSeverity as PackageEventSeverity,
  LlmErrorKind as PackageLlmErrorKind,
} from '../../packages/sdk/src/index';
import type {
  CanonicalEvent as RootCanonicalEvent,
  CanonicalEventType as RootCanonicalEventType,
  EventSeverity as RootEventSeverity,
  LlmErrorKind as RootLlmErrorKind,
} from '../../src/integrations/canonicalTypes';

/** Fails to compile unless every value of `Sub` is assignable to `Super` (and vice versa, so neither type
 * can quietly grow a member the other does not accept). */
type AssertSameShape<Super, Sub extends Super> = Sub extends Super ? (Super extends Sub ? true : never) : never;

// A value typed as the package's `CanonicalEvent` must satisfy the root `CanonicalEvent`, and vice versa.
type _canonicalEventStaysInSync = AssertSameShape<RootCanonicalEvent, PackageCanonicalEvent>;
type _canonicalEventTypeStaysInSync = AssertSameShape<RootCanonicalEventType, PackageCanonicalEventType>;
type _eventSeverityStaysInSync = AssertSameShape<RootEventSeverity, PackageEventSeverity>;
type _llmErrorKindStaysInSync = AssertSameShape<RootLlmErrorKind, PackageLlmErrorKind>;

// Referenced so the "unused" checker never flags the type aliases above; this file has no runtime behavior.
export type SdkPackageCanonicalEventCompatCheck = [
  _canonicalEventStaysInSync,
  _canonicalEventTypeStaysInSync,
  _eventSeverityStaysInSync,
  _llmErrorKindStaysInSync,
];

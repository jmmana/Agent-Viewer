/**
 * Shared secret redaction module (issue #68, 0.4.0 "usage ledger" milestone).
 *
 * Pure, dependency-free and with no runtime imports (only `import type`), the same constraint as
 * `canonicalTypes.ts`. The server, the portal and the library all import this one file, so the three
 * never disagree on what a secret is.
 *
 * This first slice ships the redaction engine itself: the built-in rule set, policy compilation
 * (including operator-supplied extra patterns and the startup self-test), text and deep-object
 * redaction, truncation that never splits a marker, and the identifier guard. Wiring this module into
 * the server ingestion path, the store, the portal and the library is tracked as follow-up work under
 * the same issue (see the PR description).
 */

import type { CanonicalEvent } from './canonicalTypes.ts';

/** A single redaction rule. `pattern` must be a global regex; never `exec` or `test` it directly, it is
 * shared and reused across calls (`String.prototype.replace` resets `lastIndex` on its own). */
export interface RedactionRule {
  /** Stable snake_case name. Appears in reports and in the replacement marker. Never the value. */
  name: string;
  /** Global regex. When `group` is set, only that capture group is replaced (keeps "Bearer ", "user:@host"). */
  pattern: RegExp;
  group?: number;
  source: 'builtin' | 'extra';
}

/** Per-event redaction result. Never contains matched text. */
export interface RedactionReport {
  /** Replacements applied to this event. 0 means "scanned, nothing found". */
  count: number;
  /** Replacements per rule name. Never contains matched text. */
  byRule: Record<string, number>;
  /** Active policy id, for example "builtin-1", "builtin-1+disable:jwt+extra-sha256:9f2c1a7b". */
  policy: string;
  /** "ingest": applied before storage. "read": applied on read to a row stored before 0.4.0 (or while
   * redaction was off). */
  scope: 'ingest' | 'read';
}

/** An identifier field that would have been rewritten had it not been guarded. Never the value. */
export interface IdentifierIssue {
  path: string;
  rule: string;
}

export interface ExtraRedactionPattern {
  name: string;
  pattern: string;
  flags?: string;
  group?: number;
}

export interface CompileRedactionPolicyOptions {
  extra?: ExtraRedactionPattern[];
  disable?: string[];
  /** The server's own secrets, exact literals. Values shorter than 8 characters are skipped (the
   * caller, typically the server, is responsible for warning about those). */
  ownSecrets?: string[];
  /** Injected by the server (`node:crypto`). Required only when `extra` is not empty. */
  sha256Hex?: (text: string) => string;
}

export interface RedactionPolicy {
  id: string;
  rules: readonly RedactionRule[];
}

/** Thrown by `compileRedactionPolicy` when a pattern, name or performance budget is violated. The
 * server treats this as a fatal startup error and never starts with a partial policy. */
export class RedactionConfigError extends Error {
  readonly patternName: string;

  constructor(patternName: string, message: string) {
    super(message);
    this.name = 'RedactionConfigError';
    this.patternName = patternName;
  }
}

export const REDACTION_POLICY_VERSION = 'builtin-1';

/** The marker the server, portal and library all use in place of a matched secret. Deterministic:
 * the same input under the same policy always produces the same output. */
export function redactionMarker(ruleName: string): string {
  return `[REDACTED:${ruleName}]`;
}

/** Envelope fields that are identifiers or enums, never free text, and are therefore guarded rather
 * than scanned for replacement. */
export const IDENTIFIER_ENVELOPE_FIELDS: readonly string[] = [
  'id',
  'type',
  'timestamp',
  'runtimeId',
  'sessionId',
  'source',
  'agentId',
  'taskId',
  'severity',
];

/** Payload fields, top level only, that are identifiers or enums. A key with the same name nested
 * inside `metadata`, `artifacts` or any other nested object is free text and is scanned normally. */
export const IDENTIFIER_PAYLOAD_FIELDS: readonly string[] = [
  'id',
  'agentId',
  'targetAgentId',
  'assignedAgentId',
  'collaboratorIds',
  'participantIds',
  'taskId',
  'toolCallId',
  'requestId',
  'meetingId',
  'roomId',
  'runtimeId',
  'provider',
  'model',
  'currency',
  'costSource',
  'kind',
  'type',
  'status',
  'team',
  'role',
  'workspace',
  'category',
  'tool',
];

/** Payload fields whose value is an array of identifier strings: every element is guarded too. */
const IDENTIFIER_ARRAY_FIELDS: readonly string[] = ['collaboratorIds', 'participantIds'];

const NOT_ALREADY_REDACTED = '(?!\\[REDACTED:)';

/**
 * Built-in rule set (`builtin-1`). Order matters: most specific first, so a value that could match more
 * than one shape (for example the server's own token appearing after "Bearer ") is labelled by the most
 * specific / highest-priority rule. Every pattern requires a minimum body length so short, innocuous
 * words never match, and tolerates truncated tails so 60- and 140-character cuts are still caught.
 */
export const BUILTIN_REDACTION_RULES: readonly RedactionRule[] = [
  // Provider API keys.
  { name: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, source: 'builtin' },
  {
    name: 'openai_api_key',
    pattern: /\bsk-(?:proj-|svcacct-|admin-|or-v1-)?(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{20,}/g,
    source: 'builtin',
  },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, source: 'builtin' },
  { name: 'huggingface_token', pattern: /\bhf_[A-Za-z0-9]{30,}/g, source: 'builtin' },
  { name: 'groq_api_key', pattern: /\bgsk_[A-Za-z0-9]{30,}/g, source: 'builtin' },
  { name: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, source: 'builtin' },
  { name: 'stripe_key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, source: 'builtin' },
  { name: 'gitlab_token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, source: 'builtin' },
  { name: 'npm_token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g, source: 'builtin' },
  // GitHub.
  {
    name: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
    source: 'builtin',
  },
  // AWS and Azure.
  { name: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, source: 'builtin' },
  {
    name: 'aws_secret_access_key',
    pattern: new RegExp(
      `\\b(?:aws_secret_access_key|aws_secret_key|secretAccessKey)["']?\\s*[:=]\\s*["']?${NOT_ALREADY_REDACTED}([A-Za-z0-9/+=]{30,})`,
      'gi',
    ),
    group: 1,
    source: 'builtin',
  },
  {
    name: 'azure_storage_key',
    pattern: new RegExp(`\\bAccountKey=${NOT_ALREADY_REDACTED}([A-Za-z0-9+/]{40,}={0,2})`, 'g'),
    group: 1,
    source: 'builtin',
  },
  // HTTP auth: the token must contain a digit, so prose such as "Bearer authentication/authorization"
  // or "Basic Responsibilities" is never touched.
  {
    name: 'bearer_token',
    pattern: new RegExp(
      `\\bBearer\\s+${NOT_ALREADY_REDACTED}((?=[A-Za-z0-9._~+/-]*[0-9])[A-Za-z0-9._~+/-]{16,}=*)`,
      'gi',
    ),
    group: 1,
    source: 'builtin',
  },
  {
    name: 'basic_auth_header',
    pattern: new RegExp(`\\bBasic\\s+${NOT_ALREADY_REDACTED}((?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{16,}=*)`, 'g'),
    group: 1,
    source: 'builtin',
  },
  // JWT (signature optional so truncated tokens still match).
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)?/g, source: 'builtin' },
  // Private keys (to END marker, or to end of string when truncated or flattened).
  {
    name: 'private_key_block',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    source: 'builtin',
  },
  // Connection strings: only the password part is replaced.
  {
    name: 'connection_string_password',
    pattern: new RegExp(`\\b[a-z][a-z0-9+.-]{1,30}://[^\\s:/@]{1,200}:${NOT_ALREADY_REDACTED}([^\\s@/]+)@`, 'gi'),
    group: 1,
    source: 'builtin',
  },
  {
    name: 'connection_string_password',
    pattern: new RegExp(`\\b(?:password|pwd)\\s*=\\s*${NOT_ALREADY_REDACTED}([^;\\s"']+)`, 'gi'),
    group: 1,
    source: 'builtin',
  },
  // Key-value dumps (printenv, .env, JSON). Values of 8+ characters that are not all digits, so numeric
  // usage keys such as input_tokens never match.
  {
    name: 'secret_assignment',
    pattern: new RegExp(
      `(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\\s*[:=]\\s*["']?${NOT_ALREADY_REDACTED}(?!\\d+(?:[\\s"',;&]|$))([^\\s"',;&]{8,})`,
      'gi',
    ),
    group: 1,
    source: 'builtin',
  },
];

const BUILTIN_RULE_NAMES = new Set(BUILTIN_REDACTION_RULES.map((rule) => rule.name));

/** Adversarial corpus used by the startup self-test, and reused by the tests. A guard against
 * accidental catastrophic backtracking, not a proof: a hostile regex can still be slow on other input. */
export function adversarialRedactionCorpus(): readonly string[] {
  return [
    'a'.repeat(64 * 1024),
    'a.a.a.'.repeat(Math.ceil((64 * 1024) / 6)),
    `sk-${'a'.repeat(64 * 1024)}`,
    'Bearer '.repeat(Math.ceil((64 * 1024) / 7)),
    `-----BEGIN PRIVATE KEY-----${'a'.repeat(64 * 1024)}`,
    '://a:'.repeat(Math.ceil((64 * 1024) / 5)),
    `password${' '.repeat(2000)}=`.repeat(Math.ceil((64 * 1024) / 2010)),
  ];
}

function escapeForLiteralRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOwnSecretRule(ownSecrets: string[] | undefined): RedactionRule | null {
  const qualifying = Array.from(new Set((ownSecrets ?? []).filter((value) => value.length >= 8)));
  if (qualifying.length === 0) {
    return null;
  }
  // Longest first, so one secret that is a prefix of another is never partially matched.
  qualifying.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(qualifying.map(escapeForLiteralRegex).join('|'), 'g');
  return { name: 'own_secret', pattern, source: 'builtin' };
}

function validateExtraName(name: string): void {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) {
    throw new RedactionConfigError(name, `Extra redaction pattern name "${name}" must match ^[a-z][a-z0-9_]{1,40}$`);
  }
  if (BUILTIN_RULE_NAMES.has(name)) {
    throw new RedactionConfigError(name, `Extra redaction pattern name "${name}" reuses a built-in rule name`);
  }
}

function validateExtraFlags(name: string, flags: string): void {
  if (!/^[imsu]*$/.test(flags)) {
    throw new RedactionConfigError(name, `Extra redaction pattern "${name}" has invalid flags "${flags}" (only i, m, s, u are allowed)`);
  }
}

/** Counts capture groups in a pattern without ever executing it against attacker-controlled input:
 * appending a harmless empty alternative keeps every original group slot in the match array. */
function countCaptureGroups(pattern: string, flags: string): number {
  const probe = new RegExp(`(?:${pattern})|`, flags.replace(/[gy]/g, ''));
  const match = probe.exec('');
  return match ? match.length - 1 : 0;
}

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  return { result, ms };
}

const EXTRA_PATTERN_SELF_TEST_BUDGET_MS = 50;
const FULL_POLICY_SELF_TEST_BUDGET_MS = 250;

function compileExtraRule(spec: ExtraRedactionPattern, seenNames: Set<string>): RedactionRule {
  const { name, pattern, flags = '', group = 0 } = spec;
  validateExtraName(name);
  if (seenNames.has(name)) {
    throw new RedactionConfigError(name, `Duplicate extra redaction pattern name "${name}"`);
  }
  seenNames.add(name);
  validateExtraFlags(name, flags);
  if (pattern.length > 500) {
    throw new RedactionConfigError(name, `Extra redaction pattern "${name}" exceeds 500 characters`);
  }

  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, `${flags}g`);
  } catch (error) {
    throw new RedactionConfigError(name, `Extra redaction pattern "${name}" is not a valid regular expression: ${(error as Error).message}`);
  }

  if (compiled.test('')) {
    throw new RedactionConfigError(name, `Extra redaction pattern "${name}" matches the empty string`);
  }
  compiled.lastIndex = 0;

  const groupCount = countCaptureGroups(pattern, flags);
  if (group < 0 || group > groupCount) {
    throw new RedactionConfigError(name, `Extra redaction pattern "${name}" has group ${group}, but only ${groupCount} capture group(s)`);
  }

  // Self-test: the pattern alone must finish the adversarial corpus within budget.
  const { ms } = timed(() => {
    for (const sample of adversarialRedactionCorpus()) {
      compiled.lastIndex = 0;
      sample.replace(compiled, () => '');
    }
  });
  if (ms > EXTRA_PATTERN_SELF_TEST_BUDGET_MS) {
    throw new RedactionConfigError(name, `Extra redaction pattern "${name}" took ${ms.toFixed(1)}ms over the adversarial corpus (budget ${EXTRA_PATTERN_SELF_TEST_BUDGET_MS}ms)`);
  }

  return { name, pattern: compiled, group: group || undefined, source: 'extra' };
}

function first8Hex(hex: string): string {
  return hex.slice(0, 8);
}

function computePolicyId(options: {
  disable: string[];
  extra: ExtraRedactionPattern[];
  sha256Hex?: (text: string) => string;
}): string {
  const parts: string[] = [REDACTION_POLICY_VERSION];

  if (options.disable.length > 0) {
    const sortedNames = [...options.disable].sort();
    parts.push(`disable:${sortedNames.join(',')}`);
  }

  if (options.extra.length > 0) {
    if (!options.sha256Hex) {
      throw new RedactionConfigError('extra', 'compileRedactionPolicy: sha256Hex is required when extra patterns are provided');
    }
    const sortedExtra = [...options.extra]
      .map((entry) => ({ name: entry.name, pattern: entry.pattern, flags: entry.flags ?? '', group: entry.group ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const digest = options.sha256Hex(JSON.stringify(sortedExtra));
    parts.push(`extra-sha256:${first8Hex(digest)}`);
  }

  return parts.join('+');
}

/** Runs every active rule, alone, over `[REDACTED:<name>]` and checks the whole policy leaves it
 * unchanged with count 0. A generic smoke test: markers are never themselves treated as secrets. */
function selfTestIdempotence(rules: readonly RedactionRule[], policyId: string): void {
  const uniqueNames = Array.from(new Set(rules.map((rule) => rule.name)));
  for (const name of uniqueNames) {
    const marker = redactionMarker(name);
    const { text, count } = redactText(marker, { id: policyId, rules });
    if (text !== marker || count !== 0) {
      throw new RedactionConfigError(name, `Redaction rule "${name}" is not idempotent on its own marker`);
    }
  }
}

/**
 * Compiles a redaction policy from the built-in rules plus operator configuration. Throws
 * `RedactionConfigError` naming the offending pattern. Fails closed: never returns a partial policy.
 */
export function compileRedactionPolicy(options: CompileRedactionPolicyOptions = {}): RedactionPolicy {
  const disable = options.disable ?? [];
  const extra = options.extra ?? [];

  for (const name of disable) {
    if (!BUILTIN_RULE_NAMES.has(name)) {
      throw new RedactionConfigError(name, `Cannot disable unknown built-in redaction rule "${name}"`);
    }
  }

  if (extra.length > 50) {
    throw new RedactionConfigError('extra', `Too many extra redaction patterns (${extra.length}), the limit is 50`);
  }

  const disableSet = new Set(disable);
  const ownSecretRule = buildOwnSecretRule(options.ownSecrets);
  const builtinRules = BUILTIN_REDACTION_RULES.filter((rule) => !disableSet.has(rule.name));

  const seenExtraNames = new Set<string>();
  const extraRules = extra.map((spec) => compileExtraRule(spec, seenExtraNames));

  const rules: RedactionRule[] = [...(ownSecretRule ? [ownSecretRule] : []), ...builtinRules, ...extraRules];

  const id = computePolicyId({ disable, extra, sha256Hex: options.sha256Hex });

  // Full-policy self-test budget, over every sample in the corpus combined.
  const { ms } = timed(() => {
    for (const sample of adversarialRedactionCorpus()) {
      redactText(sample, { id, rules });
    }
  });
  if (ms > FULL_POLICY_SELF_TEST_BUDGET_MS) {
    throw new RedactionConfigError('policy', `Full redaction policy took ${ms.toFixed(1)}ms over the adversarial corpus (budget ${FULL_POLICY_SELF_TEST_BUDGET_MS}ms)`);
  }

  selfTestIdempotence(rules, id);

  return { id, rules };
}

/** A built-in-only policy, compiled lazily and cached, for callers that do not need operator
 * configuration (the portal and the library never know the server's extra patterns). */
let cachedDefaultPolicy: RedactionPolicy | null = null;
export function defaultRedactionPolicy(): RedactionPolicy {
  if (!cachedDefaultPolicy) {
    cachedDefaultPolicy = compileRedactionPolicy();
  }
  return cachedDefaultPolicy;
}

export interface RedactTextResult {
  text: string;
  count: number;
  byRule: Record<string, number>;
}

/**
 * Replaces every match of every rule in `policy` (or the default built-in policy) with its marker.
 * Always uses `String.prototype.replace` with the rule's global regex, never `exec`/`test` on it, so
 * `lastIndex` is reset by the engine rather than hand-managed.
 */
/** A masked placeholder such as `********` or `xxxxxxxx` is not a secret. Only applied to the
 * contextual, group-based rules (key-value dumps, bearer/basic headers, connection strings): the
 * fixed-prefix provider key rules (`sk-ant-...`, `ghp_...`, ...) already require a specific charset. */
function looksLikeMaskPlaceholder(value: string): boolean {
  return /^(.)\1*$/.test(value);
}

export function redactText(text: string, policy: RedactionPolicy = defaultRedactionPolicy()): RedactTextResult {
  let result = text;
  const byRule: Record<string, number> = {};
  let count = 0;

  for (const rule of policy.rules) {
    const marker = redactionMarker(rule.name);
    result = result.replace(rule.pattern, (...args: unknown[]) => {
      // String.prototype.replace callback args: (match, ...groups, offset, string[, namedGroups]).
      const full = args[0] as string;
      const replaced = rule.group ? (typeof args[rule.group] === 'string' ? (args[rule.group] as string) : full) : full;
      if (rule.group && looksLikeMaskPlaceholder(replaced)) {
        return full;
      }
      byRule[rule.name] = (byRule[rule.name] ?? 0) + 1;
      count += 1;
      if (rule.group) {
        return full.replace(replaced, marker);
      }
      return marker;
    });
  }

  return { text: result, count, byRule };
}

/**
 * Cuts `text` to at most `max` characters without ever splitting a `[REDACTED:...]` marker: when the
 * cut would land inside one, the whole marker is dropped instead and the cut moves before it.
 */
export function truncateKeepingMarkers(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  const markerPattern = /\[REDACTED:[a-z0-9_]+\]/g;
  let match: RegExpExecArray | null;
  let safeCut = max;

  while ((match = markerPattern.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < max && end > max) {
      // The naive cut would split this marker: move the cut to just before it.
      safeCut = Math.min(safeCut, start);
    }
  }

  return text.slice(0, safeCut);
}

function isIdentifierArrayField(name: string): boolean {
  return IDENTIFIER_ARRAY_FIELDS.includes(name);
}

/**
 * Runs the active policy over identifier fields only (envelope plus the top level of `payload`, and
 * every element of the id-array payload fields) and returns the offenders. Never rewrites anything.
 */
export function findSecretsInIdentifiers(
  event: Pick<CanonicalEvent, 'id' | 'type' | 'timestamp' | 'runtimeId' | 'sessionId' | 'source' | 'agentId' | 'taskId' | 'severity' | 'payload'>,
  policy: RedactionPolicy = defaultRedactionPolicy(),
): IdentifierIssue[] {
  const issues: IdentifierIssue[] = [];
  const envelope = event as unknown as Record<string, unknown>;

  for (const field of IDENTIFIER_ENVELOPE_FIELDS) {
    const value = envelope[field];
    if (typeof value === 'string') {
      const { byRule } = redactText(value, policy);
      for (const rule of Object.keys(byRule)) {
        issues.push({ path: field, rule });
      }
    }
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  for (const field of IDENTIFIER_PAYLOAD_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string') {
      const { byRule } = redactText(value, policy);
      for (const rule of Object.keys(byRule)) {
        issues.push({ path: `payload.${field}`, rule });
      }
    } else if (isIdentifierArrayField(field) && Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (typeof entry === 'string') {
          const { byRule } = redactText(entry, policy);
          for (const rule of Object.keys(byRule)) {
            issues.push({ path: `payload.${field}[${index}]`, rule });
          }
        }
      });
    }
  }

  return issues;
}

/**
 * Deep string walker for arbitrary objects (agent records, runtime metadata, the portal payload view,
 * session exports). Iterative, so deep input cannot overflow the stack. Numbers, booleans and null pass
 * through untouched; object keys are never rewritten, only string leaf values.
 */
export function redactDeep<T>(value: T, policy: RedactionPolicy = defaultRedactionPolicy()): { value: T; count: number; byRule: Record<string, number> } {
  const byRule: Record<string, number> = {};
  let count = 0;

  function mergeStats(stats: Record<string, number>, statCount: number): void {
    count += statCount;
    for (const [rule, n] of Object.entries(stats)) {
      byRule[rule] = (byRule[rule] ?? 0) + n;
    }
  }

  // Iterative post-order-ish walk using an explicit stack: each frame rebuilds its own container once
  // all of its children are resolved, so no recursion is needed no matter how deep `value` is.
  type Frame =
    | { kind: 'array'; source: unknown[]; target: unknown[]; index: number }
    | { kind: 'object'; source: Record<string, unknown>; target: Record<string, unknown>; keys: string[]; index: number };

  function redactNode(node: unknown): unknown {
    if (typeof node === 'string') {
      const { text, count: c, byRule: r } = redactText(node, policy);
      mergeStats(r, c);
      return text;
    }
    if (node === null || typeof node !== 'object') {
      return node;
    }

    const stack: Frame[] = [];
    let root: unknown;

    const pushFrame = (source: unknown): { target: unknown } => {
      if (Array.isArray(source)) {
        const target: unknown[] = new Array(source.length);
        stack.push({ kind: 'array', source, target, index: 0 });
        return { target };
      }
      const keys = Object.keys(source as Record<string, unknown>);
      const target: Record<string, unknown> = {};
      stack.push({ kind: 'object', source: source as Record<string, unknown>, target, keys, index: 0 });
      return { target };
    };

    root = pushFrame(node).target;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];

      if (frame.kind === 'array') {
        if (frame.index >= frame.source.length) {
          stack.pop();
          continue;
        }
        const i = frame.index;
        frame.index += 1;
        const child = frame.source[i];
        if (typeof child === 'string') {
          const { text, count: c, byRule: r } = redactText(child, policy);
          mergeStats(r, c);
          frame.target[i] = text;
        } else if (child !== null && typeof child === 'object') {
          frame.target[i] = pushFrame(child).target;
        } else {
          frame.target[i] = child;
        }
      } else {
        if (frame.index >= frame.keys.length) {
          stack.pop();
          continue;
        }
        const key = frame.keys[frame.index];
        frame.index += 1;
        const child = frame.source[key];
        if (typeof child === 'string') {
          const { text, count: c, byRule: r } = redactText(child, policy);
          mergeStats(r, c);
          frame.target[key] = text;
        } else if (child !== null && typeof child === 'object') {
          frame.target[key] = pushFrame(child).target;
        } else {
          frame.target[key] = child;
        }
      }
    }

    return root;
  }

  const redacted = redactNode(value);
  return { value: redacted as T, count, byRule };
}

/**
 * Scans `summary` and the string leaves of `payload` (identifier keys at the top level of `payload`
 * are skipped, per `IDENTIFIER_PAYLOAD_FIELDS`), and attaches a `RedactionReport`. Always overwrites
 * any existing `redaction` field: clients cannot set it themselves.
 */
export function redactEvent<T extends Record<string, unknown>>(
  event: CanonicalEvent<T>,
  policy: RedactionPolicy = defaultRedactionPolicy(),
  scope: 'ingest' | 'read' = 'ingest',
): CanonicalEvent<T> & { redaction: RedactionReport } {
  const byRule: Record<string, number> = {};
  let count = 0;

  const mergeStats = (stats: Record<string, number>, statCount: number) => {
    count += statCount;
    for (const [rule, n] of Object.entries(stats)) {
      byRule[rule] = (byRule[rule] ?? 0) + n;
    }
  };

  const summaryResult = typeof event.summary === 'string' ? redactText(event.summary, policy) : null;
  if (summaryResult) {
    mergeStats(summaryResult.byRule, summaryResult.count);
  }

  const sourcePayload = (event.payload ?? {}) as Record<string, unknown>;
  const redactedPayload: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(sourcePayload)) {
    if (IDENTIFIER_PAYLOAD_FIELDS.includes(key)) {
      redactedPayload[key] = rawValue;
      continue;
    }
    const { value, count: c, byRule: r } = redactDeep(rawValue, policy);
    mergeStats(r, c);
    redactedPayload[key] = value;
  }

  const report: RedactionReport = { count, byRule, policy: policy.id, scope };

  return {
    ...event,
    summary: summaryResult ? summaryResult.text : event.summary,
    payload: redactedPayload as T,
    redaction: report,
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BUILTIN_REDACTION_RULES,
  REDACTION_POLICY_VERSION,
  RedactionConfigError,
  adversarialRedactionCorpus,
  compileRedactionPolicy,
  defaultRedactionPolicy,
  findSecretsInIdentifiers,
  redactDeep,
  redactEvent,
  redactText,
  redactionMarker,
  truncateKeepingMarkers,
} from '../src/integrations/redaction.ts';

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Token-shaped fixtures are built by concatenation at runtime (never as literal strings in the
// repository), so the repository never contains anything GitHub push protection or a scanner would
// flag as a real credential.
const FIXTURES = {
  anthropic_api_key: 'sk-ant-' + 'Qw3Rt7Yu9Pl2As5Df8G'.repeat(2),
  openai_api_key: 'sk-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn'.repeat(2),
  openai_api_key_proj: 'sk-proj-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn'.repeat(2),
  google_api_key: 'AIza' + '0Qw3Rt7Yu9Pl2As5Df8Gh1Jk4Lm7Np'.slice(0, 31),
  huggingface_token: 'hf_' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv'.slice(0, 31),
  groq_api_key: 'gsk_' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv'.slice(0, 31),
  slack_token: 'xoxb-' + '1234567890-abcdefghij',
  stripe_key: 'sk_live_' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7',
  gitlab_token: 'glpat-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn21',
  npm_token: 'npm_' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv'.slice(0, 31),
  github_token: 'ghp_' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv',
  github_pat: 'github_pat_' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8'.slice(0, 23),
  aws_access_key_id: 'AKIA' + 'AB12CD34EF56GH78',
  aws_secret_access_key: 'aws_secret_access_key=' + 'Qw3Rt7Yu9Pl2As5D'.repeat(2),
  azure_storage_key: 'AccountKey=' + 'Qw3Rt7Yu9Pl2As5Df8Gh1Jk4Lm7Np0Qr2St5Uv8Wx=='.slice(0, 42) + '==',
  bearer_token: 'Bearer ' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn',
  basic_auth_header: 'Basic ' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn',
  jwt: 'eyJ' + 'Ab1Cd2Ef3Gh4Ij5'.repeat(2) + '.eyJ' + 'Ab1Cd2Ef3Gh4Ij5'.repeat(2) + '.' + 'Ab1Cd2Ef3Gh4',
  private_key_block: '-----BEGIN RSA PRIVATE KEY-----\n' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv\n'.repeat(3) + '-----END RSA PRIVATE KEY-----',
  connection_string_password_url: 'postgres://app:' + 'Qw3Rt7Yu9Pl2As5D' + '@db.internal:5432/prod',
  connection_string_password_kv: 'password=' + 'Qw3Rt7Yu9Pl2As5D' + ';host=db.internal',
  secret_assignment: 'api_key: ' + 'Ab12Cd34Ef56Gh78',
  own_secret: 'myserver' + 'secret' + 'token12345',
};

function ruleNames() {
  return Array.from(new Set(BUILTIN_REDACTION_RULES.map((rule) => rule.name)));
}

test('redaction: every built-in rule name in BUILTIN_REDACTION_RULES has a fixture covering it', () => {
  for (const name of ruleNames()) {
    const covered = Object.entries(FIXTURES).some(([key, value]) => key === name || key.startsWith(`${name}_`));
    assert.ok(covered, `No fixture exercises built-in rule "${name}"`);
  }
});

test('redaction: compiling the default built-in policy succeeds and names it builtin-1', () => {
  const policy = compileRedactionPolicy();
  assert.equal(policy.id, REDACTION_POLICY_VERSION);
  assert.ok(policy.rules.length > 0);
});

test('redaction: defaultRedactionPolicy caches and reuses the same compiled policy', () => {
  const a = defaultRedactionPolicy();
  const b = defaultRedactionPolicy();
  assert.equal(a, b);
});

// --- True positives: full-length, 60-char cut and 140-char "trimSummary"-style cut -----------------

function trimSummaryLike(value, max) {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length > max ? `${flattened.slice(0, max)}...` : flattened;
}

// own_secret has no fixed shape: it only exists once an operator configures `ownSecrets`, so it is
// covered separately below instead of through the shared default-policy loop.
for (const [name, secret] of Object.entries(FIXTURES)) {
  if (name === 'own_secret') continue;
  test(`redaction: "${name}" fixture is fully redacted at full length`, () => {
    const { text, count } = redactText(`before ${secret} after`);
    assert.ok(count >= 1, `expected at least one replacement for ${name}`);
    assert.ok(!text.includes(secret), `secret text leaked for ${name}`);
  });
}

test('redaction: a truncated-to-60-characters sample is still caught when the minimum body survives', () => {
  const long = `token=${FIXTURES.anthropic_api_key} rest of a very long message that gets cut off eventually`;
  const cut60 = long.slice(0, 60);
  const { count } = redactText(cut60);
  assert.ok(count >= 1, 'a 60-character cut of a long-enough secret must still be caught');
});

test('redaction: a sample flattened and cut to 140 characters (trimSummary-like) is still caught', () => {
  const raw = `Tool output contained:\n\n  ${FIXTURES.github_token}\n\nplus a lot of trailing narrative text that keeps going on and on so it gets cut`;
  const trimmed = trimSummaryLike(raw, 140);
  const { count } = redactText(trimmed);
  assert.ok(count >= 1, 'a 140-character flattened cut of a long-enough secret must still be caught');
});

// --- False positives --------------------------------------------------------------------------------

const FALSE_POSITIVES = [
  'This is a completely ordinary English sentence about agents and tools.',
  'Esta es una oracion completamente normal en espanol sobre agentes y herramientas.',
  'sk-' + 'a'.repeat(10),
  'sk-learn-pipeline-for-customers',
  '550e8400-e29b-41d4-a716-446655440000',
  'a1b2c3d4e5f6789012345678901234567890abcd',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  'Bearer x',
  'Bearer authentication/authorization',
  'Basic Responsibilities',
  'Basic Telecommunications',
  'https://example.com/path?x=1',
  'http://localhost:3000/@scope/pkg',
  'gpt-4o',
  'claude-sonnet-4-5',
  'ghp_' + 'a'.repeat(20),
  'input_tokens: 12345678',
  'password: ********',
  'chatcmpl-abcdefghijklmnop',
  'msg_01abcdefghijklmnop',
  'toolu_01abcdefghijklmnop',
  'req_abcdefghijklmnop',
];

for (const sample of FALSE_POSITIVES) {
  test(`redaction: false positive left unchanged: ${JSON.stringify(sample).slice(0, 50)}`, () => {
    const { text, count, byRule } = redactText(sample);
    assert.equal(text, sample);
    assert.equal(count, 0);
    assert.deepEqual(byRule, {});
  });
}

// --- Idempotency and determinism --------------------------------------------------------------------

test('redaction: redaction is idempotent (text and count) for every fixture', () => {
  for (const [name, secret] of Object.entries(FIXTURES)) {
    const sentence = `context before ${secret} context after`;
    const once = redactText(sentence);
    const twice = redactText(once.text);
    assert.equal(twice.text, once.text, `${name}: text changed on second pass`);
    assert.equal(twice.count, 0, `${name}: second pass reported ${twice.count}, expected 0`);
  }
});

test('redaction: redaction is deterministic for the same input and policy', () => {
  const sentence = `leaked: ${FIXTURES.slack_token} and ${FIXTURES.jwt}`;
  const first = redactText(sentence);
  const second = redactText(sentence);
  assert.deepEqual(first, second);
});

// --- group replacement keeps surrounding context -----------------------------------------------------

test('redaction: bearer_token keeps the "Bearer " prefix and only replaces the token', () => {
  const { text } = redactText(`Authorization: ${FIXTURES.bearer_token}`);
  assert.equal(text, 'Authorization: Bearer [REDACTED:bearer_token]');
});

test('redaction: connection string keeps scheme, user and host, only the password is replaced', () => {
  const { text } = redactText(FIXTURES.connection_string_password_url);
  assert.equal(text, 'postgres://app:[REDACTED:connection_string_password]@db.internal:5432/prod');
});

// --- truncateKeepingMarkers -----------------------------------------------------------------------

test('truncateKeepingMarkers: text under the limit is untouched', () => {
  assert.equal(truncateKeepingMarkers('short', 100), 'short');
});

test('truncateKeepingMarkers: never splits a marker, cuts before it instead', () => {
  const redacted = redactText(`prefix words here ${FIXTURES.bearer_token} suffix words here`).text;
  const markerStart = redacted.indexOf('[REDACTED:');
  const markerEnd = redacted.indexOf(']', markerStart) + 1;
  for (let max = markerStart + 1; max < markerEnd; max += 1) {
    const cut = truncateKeepingMarkers(redacted, max);
    // A partial marker means an unclosed "[" survives past the last "]": the only brackets in this
    // fixture come from redaction markers, so this is a precise "no split marker" check.
    assert.ok(cut.lastIndexOf('[') <= cut.lastIndexOf(']'), `cut at ${max} left a partial marker: ${JSON.stringify(cut)}`);
  }
});

test('truncateKeepingMarkers: a 5000-character webhook message with a secret at offset 50 contains the full marker or none of it', () => {
  const message = `${'word '.repeat(10)}${FIXTURES.jwt} ${'filler text '.repeat(400)}`.slice(0, 5000);
  const redacted = redactText(message).text;
  const cut = truncateKeepingMarkers(redacted, 60);
  const fullMarker = redactionMarker('jwt');
  const hasFull = cut.includes(fullMarker);
  const hasNone = !cut.includes('[REDACTED');
  assert.ok(hasFull || hasNone, `expected the full marker or none of it, got ${JSON.stringify(cut)}`);
});

// --- Numeric usage fields are never touched ---------------------------------------------------------

test('redaction: redactEvent never alters numeric llm.usage fields and keeps identifiers intact', () => {
  const event = {
    schemaVersion: '1.0',
    id: 'evt_usage_1',
    type: 'llm.usage',
    timestamp: 1700000000000,
    source: 'agent:researcher',
    agentId: 'researcher',
    severity: 'normal',
    summary: `Usage report leaking ${FIXTURES.github_token}`,
    payload: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      requestId: 'req_abcdefgh',
      currency: 'USD',
      costSource: 'provider-reported',
      inputTokens: 1200,
      outputTokens: 340,
      cachedTokens: 0,
      reasoningTokens: null,
      latencyMs: 452,
      cost: 0.42,
    },
  };

  const redacted = redactEvent(event);
  assert.equal(redacted.payload.inputTokens, 1200);
  assert.equal(redacted.payload.outputTokens, 340);
  assert.equal(redacted.payload.cachedTokens, 0);
  assert.equal(redacted.payload.reasoningTokens, null);
  assert.equal(redacted.payload.latencyMs, 452);
  assert.equal(redacted.payload.cost, 0.42);
  assert.equal(redacted.payload.provider, 'anthropic');
  assert.equal(redacted.payload.model, 'claude-sonnet-4-5');
  assert.equal(redacted.payload.requestId, 'req_abcdefgh');
  assert.equal(redacted.payload.currency, 'USD');
  assert.equal(redacted.payload.costSource, 'provider-reported');
  assert.ok(!redacted.summary.includes(FIXTURES.github_token));
  assert.equal(redacted.redaction.count, 1);
  assert.deepEqual(redacted.redaction.byRule, { github_token: 1 });
  assert.equal(redacted.redaction.policy, 'builtin-1');
  assert.equal(redacted.redaction.scope, 'ingest');
});

test('redaction: redactEvent always overwrites a client-supplied redaction field', () => {
  const event = {
    schemaVersion: '1.0',
    id: 'evt_2',
    type: 'agent.status.changed',
    timestamp: 1,
    source: 'agent:x',
    severity: 'normal',
    summary: 'clean summary',
    payload: { status: 'RUNNING' },
    redaction: { count: 999, byRule: { fake: 999 }, policy: 'fake-policy', scope: 'read' },
  };

  const redacted = redactEvent(event);
  assert.equal(redacted.redaction.count, 0);
  assert.deepEqual(redacted.redaction.byRule, {});
  assert.equal(redacted.redaction.policy, 'builtin-1');
});

test('redaction: redactEvent supports scope "read" for legacy rows', () => {
  const event = {
    schemaVersion: '1.0',
    id: 'evt_3',
    type: 'tool.completed',
    timestamp: 1,
    source: 'agent:x',
    severity: 'normal',
    summary: 'done',
    payload: { outputSummary: `token leaked: ${FIXTURES.github_token}` },
  };
  const redacted = redactEvent(event, defaultRedactionPolicy(), 'read');
  assert.equal(redacted.redaction.scope, 'read');
  assert.ok(!redacted.payload.outputSummary.includes(FIXTURES.github_token));
});

// --- Identifier guard --------------------------------------------------------------------------------

test('findSecretsInIdentifiers: flags a secret in a top-level payload identifier field', () => {
  const issues = findSecretsInIdentifiers({ payload: { requestId: FIXTURES.jwt } });
  assert.deepEqual(issues, [{ path: 'payload.requestId', rule: 'jwt' }]);
});

test('findSecretsInIdentifiers: flags a secret in an envelope identifier field', () => {
  const issues = findSecretsInIdentifiers({ sessionId: FIXTURES.github_token, payload: {} });
  assert.deepEqual(issues, [{ path: 'sessionId', rule: 'github_token' }]);
});

test('findSecretsInIdentifiers: flags every offending element of an id-array field', () => {
  const issues = findSecretsInIdentifiers({ payload: { collaboratorIds: ['ok', FIXTURES.github_token] } });
  assert.deepEqual(issues, [{ path: 'payload.collaboratorIds[1]', rule: 'github_token' }]);
});

test('findSecretsInIdentifiers: a requestId nested inside metadata is not an identifier field, so it is not flagged', () => {
  const issues = findSecretsInIdentifiers({ payload: { metadata: { requestId: FIXTURES.jwt } } });
  assert.deepEqual(issues, []);
});

test('findSecretsInIdentifiers: clean identifiers produce no issues', () => {
  const issues = findSecretsInIdentifiers({
    id: 'evt_1',
    sessionId: 'session_01',
    agentId: 'researcher',
    payload: { provider: 'anthropic', model: 'claude-sonnet-4-5', requestId: 'req_abcdefgh' },
  });
  assert.deepEqual(issues, []);
});

// --- redactDeep --------------------------------------------------------------------------------------

test('redactDeep: scans string leaves in nested objects and arrays', () => {
  const input = {
    note: `leaked ${FIXTURES.github_token}`,
    nested: { list: ['clean', `also leaked ${FIXTURES.slack_token}`] },
    number: 42,
    flag: true,
    missing: null,
  };
  const { value, count, byRule } = redactDeep(input);
  assert.equal(count, 2);
  assert.deepEqual(byRule, { github_token: 1, slack_token: 1 });
  assert.ok(!value.note.includes(FIXTURES.github_token));
  assert.ok(!value.nested.list[1].includes(FIXTURES.slack_token));
  assert.equal(value.number, 42);
  assert.equal(value.flag, true);
  assert.equal(value.missing, null);
});

test('redactDeep: handles a deeply nested object without a stack overflow', () => {
  let deep = { leaf: `secret ${FIXTURES.github_token}` };
  for (let i = 0; i < 5000; i += 1) {
    deep = { child: deep };
  }
  const { value, count } = redactDeep(deep);
  assert.equal(count, 1);
  let cursor = value;
  for (let i = 0; i < 5000; i += 1) {
    cursor = cursor.child;
  }
  assert.ok(!cursor.leaf.includes(FIXTURES.github_token));
});

test('redactDeep: a bare string value is redacted directly', () => {
  const { value, count } = redactDeep(`leaked ${FIXTURES.github_token}`);
  assert.equal(count, 1);
  assert.ok(!value.includes(FIXTURES.github_token));
});

// --- own_secret ---------------------------------------------------------------------------------------

test('own_secret: a configured server secret is redacted even after "Bearer "', () => {
  const policy = compileRedactionPolicy({ ownSecrets: [FIXTURES.own_secret] });
  const { text, byRule } = redactText(`Authorization: Bearer ${FIXTURES.own_secret}`, policy);
  assert.equal(text, 'Authorization: Bearer [REDACTED:own_secret]');
  assert.deepEqual(byRule, { own_secret: 1 });
});

test('own_secret: values shorter than 8 characters are skipped, not compiled into a rule', () => {
  const policy = compileRedactionPolicy({ ownSecrets: ['short1'] });
  const { count } = redactText('the value short1 appears here', policy);
  assert.equal(count, 0);
});

test('own_secret: runs before provider-shaped rules so it is labelled own_secret', () => {
  // A value that is also shaped like a generic secret-assignment target: own_secret must win.
  const secret = 'Qw3Rt7Yu9Pl2As5D';
  const policy = compileRedactionPolicy({ ownSecrets: [secret] });
  const { byRule } = redactText(`api_key: ${secret}`, policy);
  assert.deepEqual(byRule, { own_secret: 1 });
});

// --- Extra pattern validation -------------------------------------------------------------------------

test('compileRedactionPolicy: accepts a valid extra pattern and applies it', () => {
  const policy = compileRedactionPolicy({
    extra: [{ name: 'acme_internal_token', pattern: 'acme_[A-Za-z0-9]{10,}', flags: 'i' }],
    sha256Hex,
  });
  const { text, count, byRule } = redactText('leaked acme_AbCdEfGhIjKl here', policy);
  assert.equal(count, 1);
  assert.deepEqual(byRule, { acme_internal_token: 1 });
  assert.ok(text.includes('[REDACTED:acme_internal_token]'));
});

test('compileRedactionPolicy: extra pattern name must match the required shape', () => {
  assert.throws(
    () => compileRedactionPolicy({ extra: [{ name: 'Acme-Token', pattern: 'x{10,}' }], sha256Hex }),
    RedactionConfigError,
  );
});

test('compileRedactionPolicy: extra pattern cannot reuse a built-in name', () => {
  assert.throws(
    () => compileRedactionPolicy({ extra: [{ name: 'jwt', pattern: 'x{10,}' }], sha256Hex }),
    RedactionConfigError,
  );
});

test('compileRedactionPolicy: duplicate extra pattern names are rejected', () => {
  assert.throws(
    () =>
      compileRedactionPolicy({
        extra: [
          { name: 'acme_token', pattern: 'a{10,}' },
          { name: 'acme_token', pattern: 'b{10,}' },
        ],
        sha256Hex,
      }),
    RedactionConfigError,
  );
});

test('compileRedactionPolicy: more than 50 extra patterns is rejected', () => {
  const extra = Array.from({ length: 51 }, (_, i) => ({ name: `acme_token_${i}`, pattern: 'a{10,}' }));
  assert.throws(() => compileRedactionPolicy({ extra, sha256Hex }), RedactionConfigError);
});

test('compileRedactionPolicy: a pattern over 500 characters is rejected', () => {
  const extra = [{ name: 'acme_token', pattern: `a{1,2}${'(?:x)?'.repeat(100)}` }];
  assert.ok(extra[0].pattern.length > 500);
  assert.throws(() => compileRedactionPolicy({ extra, sha256Hex }), RedactionConfigError);
});

test('compileRedactionPolicy: invalid flags are rejected', () => {
  assert.throws(
    () => compileRedactionPolicy({ extra: [{ name: 'acme_token', pattern: 'a{10,}', flags: 'x' }], sha256Hex }),
    RedactionConfigError,
  );
});

test('compileRedactionPolicy: an invalid regular expression names the pattern', () => {
  try {
    compileRedactionPolicy({ extra: [{ name: 'acme_token', pattern: '(unclosed' }], sha256Hex });
    assert.fail('expected a RedactionConfigError');
  } catch (error) {
    assert.ok(error instanceof RedactionConfigError);
    assert.equal(error.patternName, 'acme_token');
  }
});

test('compileRedactionPolicy: a pattern that matches the empty string is rejected', () => {
  assert.throws(
    () => compileRedactionPolicy({ extra: [{ name: 'acme_token', pattern: 'a*' }], sha256Hex }),
    RedactionConfigError,
  );
});

test('compileRedactionPolicy: a group index beyond the pattern\'s capture groups is rejected', () => {
  assert.throws(
    () => compileRedactionPolicy({ extra: [{ name: 'acme_token', pattern: 'acme_([A-Za-z0-9]{10,})', group: 2 }], sha256Hex }),
    RedactionConfigError,
  );
});

test('compileRedactionPolicy: extra patterns require sha256Hex to be injected', () => {
  assert.throws(
    () => compileRedactionPolicy({ extra: [{ name: 'acme_token', pattern: 'a{10,}' }] }),
    RedactionConfigError,
  );
});

test('compileRedactionPolicy: a deliberately slow extra pattern fails the startup self-test and names it', () => {
  // A single (non-nested) large bounded quantifier: purely linear backtracking, so it always
  // terminates (no catastrophic/exponential risk), but it is slow enough over the 64KB adversarial
  // corpus to clear the 50ms per-pattern budget by a wide, deterministic margin.
  try {
    compileRedactionPolicy({ extra: [{ name: 'slow_pattern', pattern: 'a{1,2000}b' }], sha256Hex });
    assert.fail('expected the slow pattern to be rejected');
  } catch (error) {
    assert.ok(error instanceof RedactionConfigError);
    assert.equal(error.patternName, 'slow_pattern');
  }
});

// --- disable --------------------------------------------------------------------------------------

test('disable: turns off a built-in rule by name', () => {
  const policy = compileRedactionPolicy({ disable: ['jwt'] });
  const { count } = redactText(FIXTURES.jwt, policy);
  assert.equal(count, 0);
});

test('disable: an unknown rule name fails startup', () => {
  assert.throws(() => compileRedactionPolicy({ disable: ['not_a_real_rule'] }), RedactionConfigError);
});

test('disable: disabling both connection_string_password patterns removes the whole rule', () => {
  const policy = compileRedactionPolicy({ disable: ['connection_string_password'] });
  assert.ok(!policy.rules.some((rule) => rule.name === 'connection_string_password'));
});

// --- Policy id ------------------------------------------------------------------------------------

test('policy id: the plain built-in policy is "builtin-1"', () => {
  assert.equal(compileRedactionPolicy().id, REDACTION_POLICY_VERSION);
});

test('policy id: disabling rules changes the id, sorted and joined', () => {
  const policy = compileRedactionPolicy({ disable: ['jwt', 'npm_token'] });
  assert.equal(policy.id, 'builtin-1+disable:jwt,npm_token');
});

test('policy id: extra patterns change the id with a stable short hash', () => {
  const spec = { name: 'acme_token', pattern: 'acme_[A-Za-z0-9]{10,}' };
  const a = compileRedactionPolicy({ extra: [spec], sha256Hex });
  const b = compileRedactionPolicy({ extra: [spec], sha256Hex });
  assert.equal(a.id, b.id);
  assert.match(a.id, /^builtin-1\+extra-sha256:[0-9a-f]{8}$/);
});

test('policy id: extra pattern order does not change the id (sorted by name before hashing)', () => {
  const a = compileRedactionPolicy({
    extra: [
      { name: 'acme_a', pattern: 'a{10,}' },
      { name: 'acme_b', pattern: 'b{10,}' },
    ],
    sha256Hex,
  });
  const b = compileRedactionPolicy({
    extra: [
      { name: 'acme_b', pattern: 'b{10,}' },
      { name: 'acme_a', pattern: 'a{10,}' },
    ],
    sha256Hex,
  });
  assert.equal(a.id, b.id);
});

// --- Adversarial corpus / performance ---------------------------------------------------------------

test('adversarialRedactionCorpus: exposes 7 roughly 64KB samples', () => {
  const corpus = adversarialRedactionCorpus();
  assert.equal(corpus.length, 7);
  for (const sample of corpus) {
    assert.ok(sample.length >= 60 * 1024, 'each sample should be roughly 64KB');
  }
});

test('performance: the built-in policy redacts the whole adversarial corpus comfortably under a loose 1s bound', () => {
  // A loose bound on purpose (per the issue's own test guidance), so a slow CI runner never flakes.
  // The 250ms startup budget is already enforced unconditionally inside compileRedactionPolicy.
  const policy = compileRedactionPolicy();
  const start = performance.now();
  for (const sample of adversarialRedactionCorpus()) {
    redactText(sample, policy);
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1000, `expected under 1000ms, took ${elapsed.toFixed(1)}ms`);
});

test('performance: a typical ~2KB event is redacted comfortably under a loose bound', () => {
  const payloadText = `Tool call finished. Output: ${'lorem ipsum dolor sit amet '.repeat(60)} token=${FIXTURES.github_token}`;
  assert.ok(payloadText.length > 1500 && payloadText.length < 2500);
  const start = performance.now();
  redactText(payloadText);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 50, `expected under 50ms, took ${elapsed.toFixed(2)}ms`);
});

test('performance: a 1MB batch body is redacted comfortably under a loose bound', () => {
  const unit = `event summary with a token ${FIXTURES.github_token} and more filler text to pad things out. `;
  const big = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
  const start = performance.now();
  redactText(big);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5000, `expected well under 5000ms (loose bound), took ${elapsed.toFixed(1)}ms`);
});

// --- Marker helper ----------------------------------------------------------------------------------

test('redactionMarker: builds the "[REDACTED:<rule>]" shape', () => {
  assert.equal(redactionMarker('github_token'), '[REDACTED:github_token]');
});

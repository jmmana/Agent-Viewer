import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateModelCost,
  getModelSpec,
  recordSimulatedCall,
  generateSimulatedCallId,
  SIMULATED_CALLS_LIMIT,
  MODEL_CATALOG,
} from '../src/engine/modelOps.ts';
import { triggerCustomTaskSimulation, createInitialSimulationState } from '../src/engine/simulationEngine.ts';
import { INITIAL_AGENTS } from '../src/engine/officeModel.ts';

// -------------------------------------------------------------
// Unknown models: no GPT-4o fallback, ever.
// -------------------------------------------------------------

test('getModelSpec has no fallback: an unknown model id returns undefined', () => {
  assert.equal(getModelSpec('unknown-model'), undefined);
  assert.equal(getModelSpec('claude-sonnet-4-5'), undefined);
});

test('getModelSpec returns the catalog entry for a known model', () => {
  const spec = getModelSpec('gpt-4o');
  assert.equal(spec?.id, 'gpt-4o');
  assert.equal(spec, MODEL_CATALOG['gpt-4o']);
});

test('calculateModelCost returns null for an unknown model, never the GPT-4o price', () => {
  assert.equal(calculateModelCost('unknown-model', 1000, 1000), null);
  assert.equal(calculateModelCost('claude-sonnet-4-5', 1000, 1000), null);
});

test('calculateModelCost returns the catalog value for a known model', () => {
  const cost = calculateModelCost('gpt-4o', 1_000_000, 0, 0);
  assert.equal(cost, 2.5);
});

test('calculateModelCost accounts for cached tokens at the cache rate', () => {
  const spec = MODEL_CATALOG['claude-3-5-sonnet'];
  const cost = calculateModelCost('claude-3-5-sonnet', 1_000_000, 0, 1_000_000);
  assert.equal(cost, spec.cachePer1M);
});

// -------------------------------------------------------------
// Simulated calls: pure recorder, always tagged, always capped.
// -------------------------------------------------------------

function simulatedCall(overrides = {}) {
  return {
    id: generateSimulatedCallId(),
    simulated: true,
    timestamp: Date.now(),
    provider: 'OpenAI',
    model: 'gpt-4o',
    agentId: null,
    preset: 'custom',
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
    estimatedCost: 0.001,
    currency: 'USD',
    latencyMs: 500,
    ...overrides,
  };
}

test('recordSimulatedCall prepends the call and always sets simulated: true', () => {
  const result = recordSimulatedCall([], { ...simulatedCall(), simulated: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].simulated, true);
});

test('recordSimulatedCall caps the list at SIMULATED_CALLS_LIMIT, newest first', () => {
  let calls = [];
  for (let i = 0; i < SIMULATED_CALLS_LIMIT + 10; i++) {
    calls = recordSimulatedCall(calls, simulatedCall({ id: `sim-${i}` }));
  }
  assert.equal(calls.length, SIMULATED_CALLS_LIMIT);
  assert.equal(calls[0].id, `sim-${SIMULATED_CALLS_LIMIT + 9}`);
});

test('generateSimulatedCallId returns distinct ids prefixed with sim-', () => {
  const a = generateSimulatedCallId();
  const b = generateSimulatedCallId();
  assert.notEqual(a, b);
  assert.match(a, /^sim-/);
});

// -------------------------------------------------------------
// New Task in live mode: countUsage: false invents nothing.
// -------------------------------------------------------------

test('triggerCustomTaskSimulation with countUsage: false leaves agent counters and totals unchanged', () => {
  const state = createInitialSimulationState(INITIAL_AGENTS, 'en');
  const before = {
    agents: state.agents.map((a) => ({ ...a })),
    totalTokens: { ...state.totalTokens },
    totalCost: state.totalCost,
  };

  triggerCustomTaskSimulation(state, 'Investigate regression', 'desc', 'backend_engineer', 'en', {
    countUsage: false,
  });

  for (const agent of state.agents) {
    const original = before.agents.find((a) => a.id === agent.id);
    assert.equal(agent.tokensInput, original.tokensInput, `tokensInput changed for ${agent.id}`);
    assert.equal(agent.tokensOutput, original.tokensOutput, `tokensOutput changed for ${agent.id}`);
    assert.equal(agent.cost, original.cost, `cost changed for ${agent.id}`);
  }
  assert.deepEqual(state.totalTokens, before.totalTokens);
  assert.equal(state.totalCost, before.totalCost);
  // The task itself is still created.
  assert.equal(state.tasks.length, 1);
});

test('triggerCustomTaskSimulation with countUsage: true (default) still adds usage, as before', () => {
  const state = createInitialSimulationState(INITIAL_AGENTS, 'en');
  const totalBefore = state.totalTokens.input;

  triggerCustomTaskSimulation(state, 'Ship feature', 'desc', 'backend_engineer', 'en');

  assert.equal(state.totalTokens.input, totalBefore + 4200);
});

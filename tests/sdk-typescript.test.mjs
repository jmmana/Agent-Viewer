import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server/index.ts';
import { AgentViewer } from '../sdk/typescript/index.ts';

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('TypeScript SDK: completes the exact 5-minute developer experience workflow', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const viewer = new AgentViewer({
      url: baseUrl,
      runtimeId: 'sdk-test-runtime',
      sessionId: 'session-sdk-01',
    });

    const agent = viewer.agent({
      id: 'researcher',
      name: 'Research Agent',
    });

    // 1. Thinking
    await agent.thinking('Analyzing documentation');

    // 2. Tool started and completed
    await agent.toolStarted('web.search');
    await agent.toolCompleted('web.search', 'found 5 results');

    // 3. Message
    await agent.message('I found the information.');

    // 4. Usage
    await agent.usage({
      provider: 'Google',
      model: 'gemini-3.1-pro',
      inputTokens: 4500,
      outputTokens: 900,
      cost: 0.012,
    });

    // 5. Done
    await agent.done();

    // Verify through snapshot
    const snapshot = await viewer.snapshot();
    assert.equal(snapshot.schemaVersion, '1.0');
    assert.ok(snapshot.agents.some((a) => a.id === 'researcher'));
    const researcher = snapshot.agents.find((a) => a.id === 'researcher');
    assert.equal(researcher?.tokensInput, 4500);
    assert.equal(researcher?.tokensOutput, 900);
  } finally {
    server.close();
  }
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectEventStream } from '../../src/integrations/realtimeClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const event = {
  id: 'evt-1',
  type: 'agent.status.changed',
  source: 'test',
  timestamp: 1_767_225_600_000,
  summary: 'demo is coding',
  payload: { agentId: 'demo', status: 'CODING' },
};

describe('connectEventStream with a token', () => {
  it('sends the token in the Authorization header, never in the URL, and parses the stream', async () => {
    const eventSource = vi.fn();
    vi.stubGlobal('EventSource', eventSource);
    const fetchImpl = vi.fn(async () => sseResponse([
      ': connected\n\n',
      `id: evt-1\ndata: ${JSON.stringify(event).slice(0, 20)}`,
      `${JSON.stringify(event).slice(20)}\n\n`,
      'event: heartbeat\ndata: {}\n\n',
    ]));
    const received: unknown[] = [];
    const statuses: string[] = [];
    const connection = connectEventStream('http://127.0.0.1:8787/', (incoming) => received.push(incoming), (s) => statuses.push(s), {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      maxReconnectAttempts: 0,
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8787/api/v1/events/stream');
    expect(url).not.toContain('secret');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(eventSource).not.toHaveBeenCalled();
    expect((received[0] as { id: string }).id).toBe('evt-1');
    expect(statuses).toContain('connected');
    expect(connection.getLastEventId()).toBe('evt-1');
    connection.close();
  });

  it('uses EventSource without a token, as before', () => {
    const instances: string[] = [];
    class FakeEventSource {
      onopen: unknown = null;
      onerror: unknown = null;
      onmessage: unknown = null;
      constructor(url: string) { instances.push(url); }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchImpl = vi.fn();
    const connection = connectEventStream('http://127.0.0.1:8787', () => {}, undefined, { fetch: fetchImpl as unknown as typeof fetch });
    expect(instances).toEqual(['http://127.0.0.1:8787/api/v1/events/stream']);
    expect(fetchImpl).not.toHaveBeenCalled();
    connection.close();
  });
});

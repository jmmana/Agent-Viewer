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

// Reconnect replay and resync (issue #54): a reconnect either replays every missed event or the server tells the
// client plainly that it must resync, never a silent partial replay. These tests exercise the fetch/header
// transport, the one a token host (including the demo app) actually uses.
describe('connectEventStream resync and replayed frames (issue #54)', () => {
  function resyncFrame(info: Record<string, unknown>) {
    return `event: resync\ndata: ${JSON.stringify(info)}\n\n`;
  }
  function replayedFrame(info: Record<string, unknown>) {
    return `event: replayed\ndata: ${JSON.stringify(info)}\n\n`;
  }

  /** `fetchImpl` that answers a different stream on each call, in order; later calls repeat the last one. */
  function sequencedFetch(responses: string[][]) {
    let callIndex = 0;
    return vi.fn(async () => sseResponse(responses[Math.min(callIndex++, responses.length - 1)]));
  }

  it('sends options.lastEventId as the lastEventId query parameter on the first connection', async () => {
    const fetchImpl = sequencedFetch([[': connected\n\n']]);
    const connection = connectEventStream('http://127.0.0.1:8787', () => {}, undefined, {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      lastEventId: 'evt_cursor_1',
      maxReconnectAttempts: 0,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('lastEventId=evt_cursor_1');
    connection.close();
  });

  it('on a resync frame: closes the source, reports resyncing, calls onResync, and reconnects with its cursor', async () => {
    const fetchImpl = sequencedFetch([
      [resyncFrame({ schemaVersion: '1.0', reason: 'gap_too_large', cursor: 'evt_old', missed: 42, replayMax: 10000 }), ': ignored after resync\n\n', `id: evt_should_not_arrive\ndata: ${JSON.stringify(event)}\n\n`],
      [': connected\n\n'],
    ]);
    const received: unknown[] = [];
    const statuses: string[] = [];
    const resyncCalls: unknown[] = [];
    const connection = connectEventStream('http://127.0.0.1:8787', (incoming) => received.push(incoming), (s) => statuses.push(s), {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      maxReconnectAttempts: 0,
      onResync: (info) => {
        resyncCalls.push(info);
        return 'evt_after_resync';
      },
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(statuses).toContain('resyncing');
    expect(resyncCalls).toEqual([{ reason: 'gap_too_large', cursor: 'evt_old', missed: 42, replayMax: 10000 }]);
    const [secondUrl] = fetchImpl.mock.calls[1] as unknown as [string];
    expect(secondUrl).toContain('lastEventId=evt_after_resync');
    expect(connection.resyncCount()).toBe(1);
    // A frame already buffered on the resynced-away source must never reach onEvent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(0);
    connection.close();
  });

  it('onResync returning null reconnects without a cursor', async () => {
    const fetchImpl = sequencedFetch([
      [resyncFrame({ reason: 'cursor_unknown', cursor: 'evt_old', missed: null, replayMax: 10000 })],
      [': connected\n\n'],
    ]);
    const connection = connectEventStream('http://127.0.0.1:8787', () => {}, undefined, {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      maxReconnectAttempts: 0,
      lastEventId: 'evt_initial',
      onResync: () => null,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const [secondUrl] = fetchImpl.mock.calls[1] as unknown as [string];
    expect(secondUrl).not.toContain('lastEventId');
    connection.close();
  });

  it('without onResync: reconnects live only (no cursor) and reports resyncing then connected', async () => {
    const fetchImpl = sequencedFetch([
      [resyncFrame({ reason: 'gap_too_large', cursor: 'evt_old', missed: 5, replayMax: 10000 })],
      [': connected\n\n'],
    ]);
    const statuses: string[] = [];
    const connection = connectEventStream('http://127.0.0.1:8787', () => {}, (s) => statuses.push(s), {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      maxReconnectAttempts: 0,
      lastEventId: 'evt_initial',
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const [secondUrl] = fetchImpl.mock.calls[1] as unknown as [string];
    expect(secondUrl).not.toContain('lastEventId');
    expect(statuses.indexOf('resyncing')).toBeGreaterThanOrEqual(0);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('connected'));
    expect(connection.resyncCount()).toBe(1);
    connection.close();
  });

  it('a resync frame with unparseable data still calls onResync with every field null/unknown', async () => {
    const fetchImpl = sequencedFetch([
      ['event: resync\ndata: not json at all\n\n'],
      [': connected\n\n'],
    ]);
    const resyncCalls: unknown[] = [];
    const connection = connectEventStream('http://127.0.0.1:8787', () => {}, undefined, {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      maxReconnectAttempts: 0,
      onResync: (info) => {
        resyncCalls.push(info);
        return undefined;
      },
    });
    await vi.waitFor(() => expect(resyncCalls).toHaveLength(1));
    expect(resyncCalls[0]).toEqual({ reason: 'unknown', cursor: null, missed: null, replayMax: null });
    connection.close();
  });

  it('when onResync rejects: reports error, retries with backoff, and calls onResync again on the next resync', async () => {
    const fetchImpl = sequencedFetch([
      [resyncFrame({ reason: 'gap_too_large', cursor: 'evt_old', missed: 5, replayMax: 10000 })],
      [resyncFrame({ reason: 'gap_too_large', cursor: 'evt_old', missed: 5, replayMax: 10000 })],
      [': connected\n\n'],
    ]);
    const statuses: string[] = [];
    let attempt = 0;
    const connection = connectEventStream('http://127.0.0.1:8787', () => {}, (s) => statuses.push(s), {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      maxReconnectAttempts: 5,
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      onResync: () => {
        attempt++;
        if (attempt === 1) throw new Error('boom');
        return undefined;
      },
    });
    await vi.waitFor(() => expect(statuses).toContain('error'));
    await vi.waitFor(() => expect(attempt).toBe(2));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    connection.close();
  });

  it('a replayed frame calls onReplayed', async () => {
    const fetchImpl = sequencedFetch([
      [replayedFrame({ schemaVersion: '1.0', cursor: 'evt_old', replayed: 3, lastEventId: 'evt_new' }), ': connected\n\n'],
    ]);
    const replayedCalls: unknown[] = [];
    const connection = connectEventStream('http://127.0.0.1:8787', () => {}, undefined, {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      maxReconnectAttempts: 0,
      lastEventId: 'evt_old',
      onReplayed: (info) => replayedCalls.push(info),
    });
    await vi.waitFor(() => expect(replayedCalls).toHaveLength(1));
    expect(replayedCalls[0]).toEqual({ replayed: 3, lastEventId: 'evt_new' });
    connection.close();
  });

  it('two consecutive resyncs with nothing in between wait for the backoff delay before reconnecting', async () => {
    const callTimes: number[] = [];
    const fetchImpl = vi.fn(async () => {
      callTimes.push(Date.now());
      const index = callTimes.length - 1;
      if (index < 2) return sseResponse([resyncFrame({ reason: 'cursor_unknown', cursor: null, missed: null, replayMax: 10000 })]);
      return sseResponse([': connected\n\n']);
    });
    const connection = connectEventStream('http://127.0.0.1:8787', () => {}, undefined, {
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
      maxReconnectAttempts: 0,
      initialBackoffMs: 150,
      maxBackoffMs: 150,
    });
    await vi.waitFor(() => expect(callTimes).toHaveLength(3), { timeout: 5000 });
    const firstGap = callTimes[1] - callTimes[0];
    const secondGap = callTimes[2] - callTimes[1];
    // The first resync (no prior data) reconnects right away; the second one in a row waits for the backoff.
    expect(firstGap).toBeLessThan(100);
    expect(secondGap).toBeGreaterThanOrEqual(120);
    connection.close();
  });
});

import type { ExternalEventEnvelope } from './eventIngestion';
import { validateExternalEvent } from './eventValidation';
import { CANONICAL_EVENT_TYPES } from './canonicalContract';

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error' | 'closed' | 'resyncing';

/**
 * A server `resync` frame (issue #54): the server could not replay every event the client missed, so the host
 * must reload its state, typically from `GET /api/v1/snapshot`. `missed` is `null`, never `0`, when the server
 * cannot know how many events were missed (an unknown cursor). `reason` passes through unrecognized values so a
 * newer server stays forward compatible with an older helper.
 */
export interface RealtimeResync {
  reason: 'cursor_unknown' | 'gap_too_large' | 'buffer_overflow' | (string & {});
  cursor: string | null;
  missed: number | null;
  replayMax: number | null;
}

/** A server `replayed` frame (issue #54): a reconnect replay finished, whether or not it replayed anything. */
export interface RealtimeReplayed {
  replayed: number;
  lastEventId: string | null;
}

export interface RealtimeConnectionOptions {
  /**
   * API token. Sent in an `Authorization: Bearer` header over a fetch-based stream, so it stays out of URLs
   * and access logs. Only where `fetch` cannot stream (no `ReadableStream`) does it fall back to `EventSource`,
   * which cannot send headers: a fresh single-use ticket is minted with `POST /api/v1/stream-tickets` before
   * every connect and reconnect, so the token itself never appears in a URL (issue #71).
   */
  token?: string;
  /** `fetch` for the token stream. Default: the global `fetch`. */
  fetch?: typeof fetch;
  maxReconnectAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatTimeoutMs?: number;
  /** Start the stream from this cursor, typically `snapshot.lastEventId` (issue #54). */
  lastEventId?: string;
  /**
   * Called when the server cannot replay what the client missed (issue #54). The host reloads its state (for
   * example from `GET /api/v1/snapshot`) and returns the cursor to resume from. Returning `null` or `undefined`
   * resumes live only, without a cursor. A throw or a rejection reconnects with the existing backoff and the
   * cursor left unchanged; `onResync` is called again on the next resync.
   */
  onResync?: (info: RealtimeResync) => string | null | undefined | Promise<string | null | undefined>;
  /** Called after a successful reconnect replay (issue #54), including one that replayed 0 events. */
  onReplayed?: (info: RealtimeReplayed) => void;
}

export interface RealtimeConnection {
  close: () => void;
  status: () => RealtimeStatus;
  getLastEventId: () => string | null;
  /** Number of resyncs this connection went through (issue #54). */
  resyncCount: () => number;
}

/** Parses a `resync` frame's `data` line. Unparseable JSON is still a resync: every field stays `null`/`'unknown'`. */
function parseResyncFrame(data: string): RealtimeResync {
  try {
    const parsed = JSON.parse(data);
    return {
      reason: typeof parsed?.reason === 'string' ? parsed.reason : 'unknown',
      cursor: typeof parsed?.cursor === 'string' ? parsed.cursor : null,
      missed: typeof parsed?.missed === 'number' ? parsed.missed : null,
      replayMax: typeof parsed?.replayMax === 'number' ? parsed.replayMax : null,
    };
  } catch {
    return { reason: 'unknown', cursor: null, missed: null, replayMax: null };
  }
}

/** Parses a `replayed` frame's `data` line. Unparseable JSON reports 0 replayed and an unknown last id. */
function parseReplayedFrame(data: string): RealtimeReplayed {
  try {
    const parsed = JSON.parse(data);
    return {
      replayed: typeof parsed?.replayed === 'number' ? parsed.replayed : 0,
      lastEventId: typeof parsed?.lastEventId === 'string' ? parsed.lastEventId : null,
    };
  } catch {
    return { replayed: 0, lastEventId: null };
  }
}

export function connectEventStream(
  baseUrl: string,
  onEvent: (event: ExternalEventEnvelope) => void,
  onStatus?: (status: RealtimeStatus) => void,
  options: RealtimeConnectionOptions = {}
): RealtimeConnection {
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  let currentStatus: RealtimeStatus = 'connecting';
  let isClosedByUser = false;
  let reconnectAttempts = 0;
  let reconnectTimer: any = null;
  let heartbeatTimer: any = null;
  let lastEventId: string | null = options.lastEventId ?? null;
  let activeEventSource: EventSource | null = null;
  let activeAbortController: AbortController | null = null;
  /** Total resyncs this connection went through (issue #54), exposed through `resyncCount()`. Never reset. */
  let totalResyncCount = 0;
  /**
   * Resyncs in a row with no event or `replayed` frame between them (issue #54). A lone resync reconnects right
   * away; from the second one in a row, it waits for the existing backoff delay so a server that keeps answering
   * `resync` cannot cause a tight loop. Reset by `handleIncomingEvent` and `handleReplayedFrame`.
   */
  let resyncStreak = 0;

  const maxAttempts = options.maxReconnectAttempts ?? Infinity;
  const initialBackoff = options.initialBackoffMs ?? 1000;
  const maxBackoff = options.maxBackoffMs ?? 15000;
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? 35000;

  function updateStatus(next: RealtimeStatus) {
    currentStatus = next;
    onStatus?.(next);
  }

  function resetHeartbeatWatchdog() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (isClosedByUser) return;
      // Heartbeat timeout reached; reconnect
      cleanupCurrent();
      scheduleReconnect();
    }, heartbeatTimeout);
  }

  function cleanupCurrent() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (activeEventSource) {
      activeEventSource.onopen = null;
      activeEventSource.onerror = null;
      activeEventSource.onmessage = null;
      activeEventSource.close();
      activeEventSource = null;
    }
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
  }

  function scheduleReconnect() {
    if (isClosedByUser) return;
    if (reconnectAttempts >= maxAttempts) {
      updateStatus('error');
      return;
    }

    updateStatus(reconnectAttempts === 0 ? 'disconnected' : 'reconnecting');
    const delay = Math.min(initialBackoff * Math.pow(1.5, reconnectAttempts), maxBackoff);
    reconnectAttempts++;

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!isClosedByUser) connect();
    }, delay);
  }

  function handleIncomingEvent(dataString: string, eventId?: string) {
    resetHeartbeatWatchdog();
    resyncStreak = 0;
    if (!dataString || dataString.trim() === '') return;

    try {
      const parsed = JSON.parse(dataString);
      if (validateExternalEvent(parsed)) {
        if (parsed.id) lastEventId = parsed.id;
        else if (eventId) lastEventId = eventId;
        onEvent(parsed);
      }
    } catch {
      // Ignore comment lines or non-JSON heartbeats
    }
  }

  /** A `replayed` frame (issue #54): tells the host a reconnect replay finished and resets the resync streak. */
  function handleReplayedFrame(dataString: string) {
    resetHeartbeatWatchdog();
    resyncStreak = 0;
    options.onReplayed?.(parseReplayedFrame(dataString));
  }

  /**
   * A `resync` frame (issue #54): the server could not replay everything the client missed. Detaches the current
   * source's listeners before awaiting `onResync`, so events still in flight on the old connection never reach
   * `onEvent`, then reconnects with the cursor `onResync` returns (or live only, without one, when there is no
   * `onResync` or it rejects).
   */
  async function handleResyncFrame(dataString: string) {
    cleanupCurrent();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    updateStatus('resyncing');
    totalResyncCount++;
    resyncStreak++;
    const info = parseResyncFrame(dataString);

    let nextCursor: string | null | undefined;
    try {
      nextCursor = options.onResync ? await options.onResync(info) : undefined;
    } catch {
      if (isClosedByUser) return;
      updateStatus('error');
      scheduleReconnect();
      return;
    }
    if (isClosedByUser) return;

    lastEventId = options.onResync ? (nextCursor ?? null) : null;

    if (resyncStreak > 1) {
      // A resync right after another one, with nothing in between: wait for the backoff delay instead of
      // reconnecting immediately, so a server stuck answering `resync` cannot cause a tight loop.
      const delay = Math.min(initialBackoff * Math.pow(1.5, resyncStreak - 2), maxBackoff);
      reconnectTimer = setTimeout(() => {
        if (!isClosedByUser) connect();
      }, delay);
    } else {
      connect();
    }
  }

  const fetchImpl = options.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  const canStreamWithHeaders = Boolean(options.token && fetchImpl && typeof ReadableStream !== 'undefined' && typeof TextDecoder !== 'undefined');

  /** Dispatches one server-sent event the way the EventSource path does. Returns true when the caller must stop reading the current source: a `resync` frame hands reconnection to `handleResyncFrame` and any later frame already buffered from the same source must never reach `onEvent` (issue #54). */
  function dispatch(eventName: string, data: string, eventId: string | undefined): boolean {
    if (eventId !== undefined) lastEventId = eventId;
    if (eventName === 'heartbeat') {
      resetHeartbeatWatchdog();
      return false;
    }
    if (eventName === 'resync') {
      void handleResyncFrame(data);
      return true;
    }
    if (eventName === 'replayed') {
      handleReplayedFrame(data);
      return false;
    }
    if (eventName === '' || eventName === 'message' || (CANONICAL_EVENT_TYPES as readonly string[]).includes(eventName)) {
      handleIncomingEvent(data, eventId);
    }
    return false;
  }

  /** The stream over fetch, with the token in the Authorization header. Parses the event stream format. */
  function connectWithHeaders(streamUrl: string) {
    const controller = new AbortController();
    activeAbortController = controller;
    const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: `Bearer ${options.token}` };
    fetchImpl!(streamUrl, { headers, signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
        if (controller.signal.aborted) return;
        reconnectAttempts = 0;
        updateStatus('connected');
        resetHeartbeatWatchdog();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventName = '';
        let data: string[] = [];
        let eventId: string | undefined;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (line === '') {
              if (data.length > 0 || eventName === 'heartbeat') {
                // A `resync` frame hands reconnection to `handleResyncFrame`: stop reading this source right
                // away, so a later frame already buffered from the same read never reaches `onEvent` (issue #54).
                const stopReading = dispatch(eventName, data.join('\n'), eventId);
                if (stopReading) return;
              }
              eventName = '';
              data = [];
              eventId = undefined;
              continue;
            }
            if (line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const fieldValue = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'data') data.push(fieldValue);
            else if (field === 'event') eventName = fieldValue;
            else if (field === 'id') eventId = fieldValue;
          }
        }
        throw new Error('stream ended');
      })
      .catch(() => {
        if (isClosedByUser || controller.signal.aborted) return;
        cleanupCurrent();
        scheduleReconnect();
      });
    // A request that never answers is retried like a silent stream.
    resetHeartbeatWatchdog();
  }

  /** The plain `EventSource` transport: no token (open mode) or a `ticket` already in `params`. */
  function connectWithEventSource(params: URLSearchParams) {
    const queryString = params.toString();
    const streamUrl = `${cleanBaseUrl}/api/v1/events/stream${queryString ? `?${queryString}` : ''}`;
    try {
      const source = new EventSource(streamUrl);
      activeEventSource = source;

      source.onopen = () => {
        reconnectAttempts = 0;
        updateStatus('connected');
        resetHeartbeatWatchdog();
      };

      source.onmessage = (msg) => {
        if (msg.lastEventId) lastEventId = msg.lastEventId;
        handleIncomingEvent(msg.data, msg.lastEventId);
      };

      for (const eventType of CANONICAL_EVENT_TYPES) {
        source.addEventListener(eventType, (msg: any) => {
          if (msg.lastEventId) lastEventId = msg.lastEventId;
          handleIncomingEvent(msg.data, msg.lastEventId);
        });
      }

      source.addEventListener('heartbeat', () => {
        resetHeartbeatWatchdog();
      });

      source.addEventListener('resync', (msg: any) => {
        void handleResyncFrame(msg.data);
      });

      source.addEventListener('replayed', (msg: any) => {
        handleReplayedFrame(msg.data);
      });

      source.onerror = () => {
        if (isClosedByUser) return;
        cleanupCurrent();
        scheduleReconnect();
      };

      resetHeartbeatWatchdog();
    } catch {
      scheduleReconnect();
    }
  }

  /**
   * `EventSource` cannot send headers and a `token` must never appear in a URL (issue #71): this mints a
   * single-use ticket with the token over `fetch`, then opens `EventSource` with that ticket instead. Called
   * fresh on every connect and reconnect, so a new ticket backs every attempt. A failed mint (expired token,
   * network error, rate limit) is treated like any other failed attempt and goes through the normal backoff;
   * it never falls back to putting the token itself in the URL.
   */
  async function connectWithTicket(params: URLSearchParams) {
    try {
      const response = await fetchImpl!(`${cleanBaseUrl}/api/v1/stream-tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
        body: '{}',
        cache: 'no-store',
      });
      if (isClosedByUser) return;
      if (!response.ok) {
        cleanupCurrent();
        scheduleReconnect();
        return;
      }
      const body = await response.json().catch(() => undefined);
      const ticket = typeof body?.ticket === 'string' ? body.ticket : undefined;
      if (isClosedByUser) return;
      if (!ticket) {
        cleanupCurrent();
        scheduleReconnect();
        return;
      }
      const ticketParams = new URLSearchParams(params);
      ticketParams.set('ticket', ticket);
      connectWithEventSource(ticketParams);
    } catch {
      if (isClosedByUser) return;
      cleanupCurrent();
      scheduleReconnect();
    }
  }

  function connect() {
    if (isClosedByUser) return;
    cleanupCurrent();

    updateStatus(reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const params = new URLSearchParams();
    if (lastEventId) {
      params.set('lastEventId', lastEventId);
    }

    if (canStreamWithHeaders) {
      const queryString = params.toString();
      connectWithHeaders(`${cleanBaseUrl}/api/v1/events/stream${queryString ? `?${queryString}` : ''}`);
      return;
    }

    if (options.token) {
      // fetch cannot stream here either: EventSource is the only option, and it cannot send a header, so a
      // ticket stands in for the token (issue #71). Without any fetch at all there is no way to mint one, and
      // the token must never go in the URL, so the connection simply stops.
      if (!fetchImpl) {
        updateStatus('error');
        return;
      }
      void connectWithTicket(params);
      return;
    }

    connectWithEventSource(params);
  }

  connect();

  return {
    close: () => {
      isClosedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      cleanupCurrent();
      updateStatus('closed');
    },
    status: () => currentStatus,
    getLastEventId: () => lastEventId,
    resyncCount: () => totalResyncCount,
  };
}

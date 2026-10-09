import type { ExternalEventEnvelope } from './eventIngestion';
import { validateExternalEvent } from './eventValidation';
import { CANONICAL_EVENT_TYPES } from './canonicalContract';

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error' | 'closed';

export interface RealtimeConnectionOptions {
  /**
   * API token. Sent in an `Authorization: Bearer` header over a fetch-based stream, so it stays out of URLs
   * and access logs. Only where `fetch` cannot stream (no `ReadableStream`) does it fall back to EventSource
   * with a `token` query parameter, since EventSource cannot send headers.
   */
  token?: string;
  /** `fetch` for the token stream. Default: the global `fetch`. */
  fetch?: typeof fetch;
  maxReconnectAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface RealtimeConnection {
  close: () => void;
  status: () => RealtimeStatus;
  getLastEventId: () => string | null;
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
  let lastEventId: string | null = null;
  let activeEventSource: EventSource | null = null;
  let activeAbortController: AbortController | null = null;

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

  const fetchImpl = options.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  const canStreamWithHeaders = Boolean(options.token && fetchImpl && typeof ReadableStream !== 'undefined' && typeof TextDecoder !== 'undefined');

  /** Dispatches one server-sent event the way the EventSource path does. */
  function dispatch(eventName: string, data: string, eventId: string | undefined) {
    if (eventId !== undefined) lastEventId = eventId;
    if (eventName === 'heartbeat') {
      resetHeartbeatWatchdog();
      return;
    }
    if (eventName === '' || eventName === 'message' || (CANONICAL_EVENT_TYPES as readonly string[]).includes(eventName)) {
      handleIncomingEvent(data, eventId);
    }
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
              if (data.length > 0 || eventName === 'heartbeat') dispatch(eventName, data.join('\n'), eventId);
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

  function connect() {
    if (isClosedByUser) return;
    cleanupCurrent();

    updateStatus(reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    // Build URL with optional lastEventId; the token goes in a header when the browser can stream with fetch.
    let streamUrl = `${cleanBaseUrl}/api/v1/events/stream`;
    const params = new URLSearchParams();
    if (lastEventId) {
      params.set('lastEventId', lastEventId);
    }
    if (options.token && !canStreamWithHeaders) {
      params.set('token', options.token);
    }
    const queryString = params.toString();
    if (queryString) {
      streamUrl += `?${queryString}`;
    }

    if (canStreamWithHeaders) {
      connectWithHeaders(streamUrl);
      return;
    }

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
  };
}

import type { ExternalEventEnvelope } from './eventIngestion';
import { validateExternalEvent } from './eventValidation';
import { CANONICAL_EVENT_TYPES } from './canonicalContract';

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error' | 'closed';

export interface RealtimeConnectionOptions {
  token?: string;
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

  function connect() {
    if (isClosedByUser) return;
    cleanupCurrent();

    updateStatus(reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    // Build URL with optional lastEventId and token query parameter
    let streamUrl = `${cleanBaseUrl}/api/v1/events/stream`;
    const params = new URLSearchParams();
    if (lastEventId) {
      params.set('lastEventId', lastEventId);
    }
    if (options.token) {
      params.set('token', options.token);
    }
    const queryString = params.toString();
    if (queryString) {
      streamUrl += `?${queryString}`;
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

import type { ExternalEventEnvelope } from './eventIngestion';
import { validateExternalEvent } from './eventIngestion';

export interface RealtimeConnection {
  close: () => void;
}

export function connectEventStream(
  baseUrl: string,
  onEvent: (event: ExternalEventEnvelope) => void,
  onStatus?: (status: 'connecting' | 'connected' | 'error' | 'closed') => void,
): RealtimeConnection {
  onStatus?.('connecting');
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/events/stream`;
  const source = new EventSource(url);

  source.onopen = () => onStatus?.('connected');
  source.onerror = () => onStatus?.('error');
  source.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data);
      if (validateExternalEvent(parsed)) onEvent(parsed);
    } catch {
      // Ignore malformed transport frames; the server remains connected.
    }
  };

  return {
    close: () => {
      source.close();
      onStatus?.('closed');
    },
  };
}

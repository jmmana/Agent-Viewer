import type { EventStore } from '../../server/store';

declare const store: EventStore;

// @ts-expect-error Usage is only changed by llm.usage events.
void store.upsertAgent({ id: 'typecheck-agent', tokensInput: 1 });

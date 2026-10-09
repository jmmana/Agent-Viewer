import { randomUUID } from 'node:crypto';
import type { CanonicalEvent } from '../src/integrations/canonicalTypes.ts';
import type { SendCommand } from './args.ts';
import { postEvents, resolveConnection } from './connection.ts';

/** Builds the canonical V1 events for `agent-viewer send`: a status change, then the message if there is one. */
export function buildSendEvents(
  options: Pick<SendCommand, 'agent' | 'status' | 'message'>,
  now: number = Date.now(),
  newId: () => string = () => randomUUID(),
): CanonicalEvent[] {
  const source = 'cli:agent-viewer';
  const events: CanonicalEvent[] = [
    {
      schemaVersion: '1.0',
      id: `evt_cli_${newId()}`,
      type: 'agent.status.changed',
      timestamp: now,
      source,
      agentId: options.agent,
      severity: 'normal',
      summary: `${options.agent} is ${options.status}`,
      payload: { status: options.status },
    },
  ];
  if (options.message) {
    events.push({
      schemaVersion: '1.0',
      id: `evt_cli_${newId()}`,
      type: 'agent.message.sent',
      timestamp: now,
      source,
      agentId: options.agent,
      severity: 'normal',
      summary: `${options.agent}: ${options.message.slice(0, 60)}`,
      payload: { text: options.message },
    });
  }
  return events;
}

/** Runs `agent-viewer send`. Returns the process exit code. */
export async function runSend(command: SendCommand): Promise<number> {
  const connection = resolveConnection(command);
  const events = buildSendEvents(command);
  try {
    const result = await postEvents(connection, events, { signal: AbortSignal.timeout(10_000) });
    if (!result.ok) {
      const detail = result.status === 401
        ? 'the server wants a token: pass --token, or set AGENT_VIEWER_API_TOKEN'
        : JSON.stringify(result.body);
      console.error(`agent-viewer: the server answered ${result.status}: ${detail}`);
      return 1;
    }
    const kinds = events.map((event) => event.type).join(' + ');
    console.log(`Sent ${kinds} for "${command.agent}" to ${connection.url}`);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`agent-viewer: could not reach ${connection.url} (${reason}). Is "npx @warlockcode/agent-viewer" running?`);
    return 1;
  }
}

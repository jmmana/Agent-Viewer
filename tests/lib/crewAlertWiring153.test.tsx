import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CrewStage } from '../../src/crew/CrewStage';
import { defaultCrewPreferences } from '../../src/crew/crewPreferences';
import type { Agent } from '../../src/types/agent';

/**
 * Cableado visual real de la alerta de #153 dentro de `CrewStage.tsx` (antes del grep que
 * motivó este trabajo, `CrewStage.tsx` no tenía NINGUNA referencia a
 * `crewAlertBridge.ts`/`crewAlertIcon.ts`/`crewAlertLayer.ts`). El canvas en sí no es
 * inspeccionable fácilmente en jsdom; estas pruebas verifican el texto equivalente que
 * `CrewStage` ya expone en el listado de agentes de la sala activa (igual que ya hace para
 * la llamada de #145 con `callPhaseLabel`), que es exactamente el requisito literal del
 * issue de "conservar el estado visible como texto" y la base real del aislamiento por
 * sala: ese listado solo contiene `visibleAgents` de la sala activa, el mismo mecanismo
 * estructural que ya aisla `callStyles`.
 */

function buildAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Agent Fixture',
    role: 'backend_engineer',
    roleTitle: 'Developer',
    team: 'engineering',
    managerId: null,
    provider: 'anthropic',
    model: 'test-model',
    status: 'CODING',
    statusText: 'Trabajando',
    currentTaskId: null,
    currentTool: null,
    workspace: 'development',
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    isWalking: false,
    facing: 'SE',
    avatarColor: '#000000',
    clothingColor: '#111111',
    hairColor: '#222222',
    accessory: 'none',
    tokensInput: 0,
    tokensOutput: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    startedAt: 0,
    speechBubble: null,
    ...overrides,
  };
}

describe('Wiring visual real de alertas Crew en CrewStage (#153)', () => {
  it('un agente BLOCKED muestra su alerta como texto en la sala donde está, en inglés y español', () => {
    const blocked = buildAgent({ id: 'dev-1', name: 'Dev One', status: 'BLOCKED', workspace: 'development' });
    const { getByText, rerender } = render(
      <CrewStage locale="en" agents={[blocked]} selectedRoomId="development" persistCamera={false}
        preferences={defaultCrewPreferences()} idPrefix="alert-153-text-en" />,
    );
    expect(getByText(/Blocked/, { exact: false })).toBeTruthy();

    rerender(
      <CrewStage locale="es" agents={[blocked]} selectedRoomId="development" persistCamera={false}
        preferences={defaultCrewPreferences()} idPrefix="alert-153-text-en" />,
    );
    expect(getByText(/Bloqueado/, { exact: false })).toBeTruthy();
  });

  it('aislamiento real por sala: dos oficinas con alertas simultáneas, cada una solo ve la suya', () => {
    const blockedInDev = buildAgent({ id: 'dev-1', name: 'Dev One', status: 'BLOCKED', workspace: 'development' });
    const waitingApprovalInQa = buildAgent({ id: 'qa-1', name: 'QA One', status: 'WAITING_APPROVAL', workspace: 'qa_lab' });
    const agents = [blockedInDev, waitingApprovalInQa];

    const { queryByText, rerender } = render(
      <CrewStage locale="es" agents={agents} selectedRoomId="development" persistCamera={false}
        preferences={defaultCrewPreferences()} idPrefix="alert-153-isolation" />,
    );
    // Viendo Desarrollo: solo la alerta de Desarrollo (Bloqueado), nunca la de QA.
    expect(queryByText(/Bloqueado/, { exact: false })).toBeTruthy();
    expect(queryByText(/Aprobación solicitada/, { exact: false })).toBeNull();

    rerender(
      <CrewStage locale="es" agents={agents} selectedRoomId="qa" persistCamera={false}
        preferences={defaultCrewPreferences()} idPrefix="alert-153-isolation" />,
    );
    // Viendo QA: solo la alerta de QA (Aprobación solicitada), nunca la de Desarrollo.
    expect(queryByText(/Aprobación solicitada/, { exact: false })).toBeTruthy();
    expect(queryByText(/Bloqueado/, { exact: false })).toBeNull();
  });

  it('cambiar de sala y volver conserva la misma alerta (el estado no vive en la sala, solo su dibujo)', () => {
    const blockedInDev = buildAgent({ id: 'dev-1', name: 'Dev One', status: 'BLOCKED', workspace: 'development' });
    const otherAgentInQa = buildAgent({ id: 'qa-1', name: 'QA One', status: 'CODING', workspace: 'qa_lab' });
    const agents = [blockedInDev, otherAgentInQa];

    const { queryByText, rerender } = render(
      <CrewStage locale="es" agents={agents} selectedRoomId="development" persistCamera={false}
        preferences={defaultCrewPreferences()} idPrefix="alert-153-persist" />,
    );
    expect(queryByText(/Bloqueado/, { exact: false })).toBeTruthy();

    // Cambiar a QA: el agente bloqueado no se ve aquí, su alerta no se dibuja.
    rerender(
      <CrewStage locale="es" agents={agents} selectedRoomId="qa" persistCamera={false}
        preferences={defaultCrewPreferences()} idPrefix="alert-153-persist" />,
    );
    expect(queryByText(/Bloqueado/, { exact: false })).toBeNull();

    // Volver a Desarrollo de inmediato: el agente real sigue reportando BLOCKED (no hubo
    // ninguna transición de status), así que la misma alerta local sigue visible, sin que
    // cambiar de sala la haya reiniciado ni perdido.
    rerender(
      <CrewStage locale="es" agents={agents} selectedRoomId="development" persistCamera={false}
        preferences={defaultCrewPreferences()} idPrefix="alert-153-persist" />,
    );
    expect(queryByText(/Bloqueado/, { exact: false })).toBeTruthy();
  });

  it('con movimiento reducido, el estado sigue visible como texto (la animación se desactiva, no el aviso)', () => {
    const blocked = buildAgent({ id: 'dev-1', name: 'Dev One', status: 'BLOCKED', workspace: 'development' });
    const { getByText } = render(
      <CrewStage locale="es" agents={[blocked]} selectedRoomId="development" persistCamera={false}
        preferences={{ ...defaultCrewPreferences(), reducedMotion: true }} idPrefix="alert-153-reduced-motion" />,
    );
    expect(getByText(/Bloqueado/, { exact: false })).toBeTruthy();
  });

  it('un status sin alerta mapeada (p. ej. disponible) no agrega ningún texto de alerta', () => {
    const available = buildAgent({ id: 'dev-1', name: 'Dev One', status: 'AVAILABLE', workspace: 'development' });
    const { queryByText } = render(
      <CrewStage locale="es" agents={[available]} selectedRoomId="development" persistCamera={false}
        preferences={defaultCrewPreferences()} idPrefix="alert-153-no-alert" />,
    );
    expect(queryByText(/Bloqueado|Aprobación solicitada|Error en el agente|Incidente/, { exact: false })).toBeNull();
  });
});

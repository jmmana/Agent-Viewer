import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CrewStage } from '../../../src/crew/CrewStage';
import { buildOfficeSnapshot } from '../../../src/lib/officeStore';
import type { Agent } from '../../../src/types/agent';
const initial = Object.freeze(buildOfficeSnapshot([], { now: 0, agents: [{ id: 'desk-fixture', name: 'Fixture CEO', workspace: 'boss_office' }] }).agents
  .map(agent => Object.freeze({ ...agent, role: 'boss' as const, facing: 'SE' as const, status: 'IDLE' as const, isWalking: false })));
export type DesktopPatch = { status?: Agent['status']; facing?: Agent['facing']; mounted?: boolean; locale?: string; second?: boolean };
declare global { interface Window { __crewDesktopFixture: (patch: DesktopPatch) => void } }
function Fixture() {
  const [state, setState] = useState({ status: 'IDLE' as Agent['status'], facing: 'SE' as Agent['facing'], mounted: true, locale: 'en', second: false });
  window.__crewDesktopFixture = patch => setState(previous => ({ ...previous, ...patch }));
  const agents = initial.map(agent => Object.freeze({ ...agent, status: state.status, facing: state.facing }));
  if (state.second) agents.push(Object.freeze({ ...agents[0], id: 'second', name: 'Second CEO', facing: 'NW', status: 'IDLE' }));
  return <>
    <h1 style={{ font: '16px sans-serif', color: 'white', margin: 8 }}>{state.locale === 'es' ? 'DEMO: acciones sintéticas de escritorio del CEO.' : 'DEMO: synthetic CEO desk actions.'}</h1>
    <output hidden data-testid="original-snapshot">{JSON.stringify(initial)}</output>
    <div style={{ height: 'calc(100vh - 50px)', minHeight: 520 }}>{state.mounted && <CrewStage viewerMode="DEMO" agents={agents} locale={state.locale} persistCamera={false} showRoomLink={false} />}</div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

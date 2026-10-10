import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CrewStage} from '../../../src/crew/CrewStage';
import {buildOfficeSnapshot} from '../../../src/lib/officeStore';
import type {Agent} from '../../../src/types/agent';
const facings:Agent['facing'][]=['SE','SW','NW','NE'];
const initial=buildOfficeSnapshot([],{now:0,agents:facings.map((_,i)=>({id:`ceo-${i}`,name:`Fixture ${i}`,workspace:'boss_office'}))}).agents
  .map((agent,i)=>Object.freeze({...agent,role:'boss' as const,facing:facings[i]}));
function Fixture(){
  const [agents,setAgents]=useState<readonly Agent[]>(initial);
  return <>
    <h1>DEMO sintética: orientación por agente</h1>
    <button onClick={()=>setAgents(previous=>previous.map((agent,i)=>i===0 ? {...agent,facing:'SW'} : agent))}>Girar primer agente</button>
    <output hidden data-testid="snapshot">{JSON.stringify(agents)}</output>
    <div style={{height:650}}><CrewStage agents={agents} locale="es" persistCamera={false} showRoomLink={false}/></div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

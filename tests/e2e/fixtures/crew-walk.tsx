import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CrewStage} from '../../../src/crew/CrewStage';
import {buildOfficeSnapshot} from '../../../src/lib/officeStore';
import {builtInMessages} from '../../../src/content/officeMessages';
import type {Agent,WorkspaceZone} from '../../../src/types/agent';
const WORKSPACE_ZONES:readonly WorkspaceZone[]=['boss_office','leads_area','development','qa_lab','research_area','server_room','meeting_room','meeting_room_b','overflow_floor','break_room'];
// `workspace` defaults to the original 'boss_office' so every existing test URL (none of
// which sets it) keeps placing the fixture agent in the CEO room exactly as before; issue
// #129's navigation spec passes `?workspace=development` to exercise a real, longer walk.
const requestedWorkspace=new URLSearchParams(window.location.search).get('workspace');
const fixtureWorkspace:WorkspaceZone=WORKSPACE_ZONES.includes(requestedWorkspace as WorkspaceZone)?requestedWorkspace as WorkspaceZone:'boss_office';
const initial=Object.freeze(buildOfficeSnapshot([],{now:0,agents:[{id:'walk-fixture',name:'Fixture CEO',workspace:fixtureWorkspace}]}).agents
  .map(agent=>Object.freeze({...agent,role:'boss' as const,facing:'SE' as const,isWalking:true})));
export type FixturePatch={walking?:boolean;mounted?:boolean;locale?:string;role?:Agent['role']};
declare global {interface Window {__crewWalkFixture:(patch:FixturePatch)=>void}}
function Fixture(){
  const parameters=new URLSearchParams(window.location.search);
  const [state,setState]=useState({walking:parameters.get('walking')!=='false',mounted:true,locale:'en',
    role:(parameters.get('role')==='other'?'backend_engineer':'boss') as Agent['role']});
  window.__crewWalkFixture=patch=>setState(previous=>({...previous,...patch}));
  const agents=initial.map(agent=>Object.freeze({...agent,isWalking:state.walking,role:state.role}));
  return <>
    <h1 style={{font:'16px sans-serif',color:'white',margin:8}}>{builtInMessages(state.locale)['crew.walkDemo']}</h1>
    <output hidden data-testid="original-snapshot">{JSON.stringify(initial)}</output>
    <output hidden data-testid="reported-snapshot">{JSON.stringify(agents)}</output>
    <div style={{height:'calc(100vh - 50px)',minHeight:520}}>{state.mounted && <CrewStage viewerMode="DEMO" agents={agents} locale={state.locale} selectedRoomId={parameters.get('room')??undefined} persistCamera={false} showRoomLink={false}/>}</div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

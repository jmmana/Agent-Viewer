import { describe, expect, it } from 'vitest';
import { crewAgentsInRoom, crewRoomForWorkspace } from '../../src/crew/crewEvents';

describe('Crew read-only event bridge', () => {
  const agents = [
    { id: '1', name: 'Elena', workspace: 'development' as const, status: 'CODING' as const },
    { id: '2', name: 'CEO', workspace: 'boss_office' as const, status: 'IDLE' as const },
    { id: '3', name: 'QA', workspace: 'qa_lab' as const, status: 'TESTING' as const },
  ];
  it('maps only explicitly built rooms', () => {
    expect(crewRoomForWorkspace('boss_office')).toBe('ceo');
    expect(crewRoomForWorkspace('development')).toBe('development');
    expect(crewRoomForWorkspace('qa_lab')).toBe('qa');
    expect(crewRoomForWorkspace('unknown')).toBeNull();
  });
  it('shows real actors of selected room, not agents from another room', () => {
    expect(crewAgentsInRoom(agents, 'ceo').map(a=>a.id)).toEqual(['2']);
    expect(crewAgentsInRoom(agents, 'development').map(a=>a.id)).toEqual(['1']);
    expect(crewAgentsInRoom(agents, 'qa').map(a=>a.id)).toEqual(['3']);
    expect(crewAgentsInRoom(agents, 'finance')).toEqual([]);
    expect(crewAgentsInRoom([], 'ceo')).toEqual([]);
  });
  it('never mutates the authoritative input', () => {
    const before = JSON.stringify(agents);
    crewAgentsInRoom(agents, 'development');
    expect(JSON.stringify(agents)).toBe(before);
  });
});

import { crewRoomActivity } from '../../src/crew/crewEvents';
describe('Resumen de actividad de sala Crew', () => {
  const a = (id:string,workspace:string,currentTaskId:string|null) => ({id,name:id,workspace,status:'IDLE',currentTaskId}) as never;
  it('cuenta solo agentes de la sala, tareas y reuniones activas con participantes presentes', () => {
    const agents = [a('x','development','t1'),a('y','development',null),a('z','qa_lab','t2')];
    const meetings = [{status:'ACTIVE',participants:['y']},{status:'CONCLUDED',participants:['x']},{status:'ACTIVE',participants:['z']}] as never;
    expect(crewRoomActivity(agents,meetings,'development')).toEqual({agents:2,withTask:1,activeMeetings:1});
    expect(crewRoomActivity([],[],'development')).toEqual({agents:0,withTask:0,activeMeetings:0});
  });
});

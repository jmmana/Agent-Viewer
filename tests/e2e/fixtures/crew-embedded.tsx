import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentOffice, type CrewCameraByRoom, type VisualMode } from '../../../src/lib/index';
import '../../../src/lib/agent-viewer.css';

function Host({name}:{name:string}) {
  const [mode,setMode] = useState<VisualMode>('crew');
  const [room,setRoom] = useState('ceo');
  const [cameras,setCameras] = useState<CrewCameraByRoom>({});
  return <article data-testid={name} style={{minWidth:0}}>
    <h2>{name}</h2>
    <button onClick={()=>setMode(current=>current==='crew'?'cartoon':'crew')}>Cambiar modo</button>
    <AgentOffice visualMode={mode} crewRoomId={room} onCrewRoomChange={setRoom}
      crewCameras={cameras} onCrewCamerasChange={setCameras}
      ariaLabel={name} locale="es" style={{height:560}} />
  </article>;
}

createRoot(document.getElementById('root')!).render(<>
  <h1>DEMO de integración: dos instancias independientes sin eventos</h1>
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%, 420px),1fr))',gap:24}}>
    <Host name="Equipo uno" /><Host name="Equipo dos" />
  </div>
</>);

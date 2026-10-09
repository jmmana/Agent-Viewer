import React, { useMemo, useState } from 'react';
import { CREW_ROOMS } from './crewModel';
import { crewAgentsInRoom } from './crewEvents';
import type { Agent } from '../types/agent';

/** Búsqueda local bilingüe; nunca cambia la selección ni filtra eventos del store. */
export function CrewRoomSelector({ roomId, onChange, agents, isEs, idPrefix }: {
  roomId: string; onChange: (id: string) => void; agents: readonly Agent[]; isEs: boolean; idPrefix: string;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    const search = normalize(query.trim());
    return CREW_ROOMS.filter(room => normalize(`${room.id} ${room.label.en} ${room.label.es}`).includes(search));
  }, [query]);
  // La oficina activa sigue disponible para que un filtro sin resultados no cambie la escena.
  const options = CREW_ROOMS.filter(room => room.id === roomId || matches.includes(room));
  return <>
    <label htmlFor={`${idPrefix}-room-search`}>{isEs ? 'Buscar oficina' : 'Search offices'}</label>
    <input id={`${idPrefix}-room-search`} type="search" value={query}
      onChange={event => setQuery(event.target.value)}
      aria-describedby={`${idPrefix}-room-results`}
      style={{ color: '#111827', background: '#fff', padding: 6, minWidth: 0, width: 150, maxWidth: '100%' }} />
    <label htmlFor={`${idPrefix}-room`}>{isEs ? 'Oficina' : 'Office'}</label>
    <select id={`${idPrefix}-room`} value={roomId} onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = options.findIndex(room => room.id === roomId);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
          : Math.max(0, Math.min(options.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
        if (options[next].id !== roomId) onChange(options[next].id);
      }}
      style={{ color: '#111827', background: '#fff', padding: 6, maxWidth: '100%' }}>
      {options.map(room => {
        const count = crewAgentsInRoom(agents, room.id).length;
        const state = count ? `${count}/${room.capacity}` : (isEs ? 'vacía' : 'empty');
        return <option key={room.id} value={room.id}>{isEs ? room.label.es : room.label.en} · {state}</option>;
      })}
    </select>
    <span id={`${idPrefix}-room-results`} aria-live="polite" style={{ fontSize: 12 }}>
      {query && (matches.length ? (isEs ? `${matches.length} oficinas encontradas` : `${matches.length} offices found`)
        : (isEs ? 'Sin coincidencias. Se conserva la oficina activa.' : 'No matches. The active office stays selected.'))}
    </span>
  </>;
}

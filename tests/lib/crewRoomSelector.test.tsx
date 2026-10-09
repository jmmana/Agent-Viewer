import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CrewRoomSelector } from '../../src/crew/CrewRoomSelector';
import type { Agent } from '../../src/types/agent';

describe('Selector de catálogo Crew #168', () => {
  it('busca nombres de ambos idiomas sin acentos y conserva activa sin coincidencias', () => {
    const change = vi.fn();
    render(<CrewRoomSelector roomId="development" onChange={change} agents={[]} isEs idPrefix="test" />);
    const search = screen.getByRole('searchbox', { name: 'Buscar oficina' });
    fireEvent.change(search, {target:{value:'direccion'}});
    expect(screen.getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['ceo', 'development']);
    fireEvent.change(search, {target:{value:'finance'}});
    expect(screen.getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['development', 'finance']);
    fireEvent.change(search, {target:{value:'no-such-room'}});
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('development');
    expect(screen.getByText('Sin coincidencias. Se conserva la oficina activa.')).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(search, {target:{value:''}});
    expect(screen.getAllByRole('option')).toHaveLength(11);
  });
  it('muestra ocupación del snapshot y notifica una elección sin modificar agentes', () => {
    const agents = Object.freeze([Object.freeze({id:'one',name:'Fixture',status:'CODING',workspace:'development'})]) as unknown as readonly Agent[];
    const change = vi.fn();
    render(<CrewRoomSelector roomId="ceo" onChange={change} agents={agents} isEs={false} idPrefix="test" />);
    expect(screen.getByRole('option', {name:/CEO Office · empty/})).toBeTruthy();
    expect(screen.getByRole('option', {name:/Development · 1\//})).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'development'}});
    expect(change).toHaveBeenCalledExactlyOnceWith('development');
    fireEvent.keyDown(screen.getByRole('combobox'),{key:'End'});
    expect(change).toHaveBeenLastCalledWith('reception');
    change.mockClear();
    for (const modifier of ['altKey','ctrlKey','metaKey','shiftKey']) {
      expect(fireEvent.keyDown(screen.getByRole('combobox'),{key:'ArrowDown',[modifier]:true})).toBe(true);
    }
    expect(change).not.toHaveBeenCalled();
    expect(agents[0].workspace).toBe('development');
  });
});

import React, { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentOffice, type CrewCameraByRoom } from '../../src/lib/index';
import { registered, statusChanged } from './fixtures';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
const events = [registered('fixture', 'Agente de prueba', {workspace:'development'}), statusChanged('fixture','CODING')];

describe('API embebida Crew', () => {
  it('conserva Caricatura por defecto y los mismos agentes al alternar renderer', () => {
    const {rerender, container} = render(<AgentOffice events={events} />);
    expect(container.querySelector('.av-office')?.getAttribute('data-visual-mode')).toBe('cartoon');
    expect(screen.queryByRole('combobox',{name:'Office'})).toBeNull();
    const original = container.querySelector('li[data-agent-id="fixture"]')?.textContent;
    rerender(<AgentOffice events={events} visualMode="crew" />);
    fireEvent.change(screen.getByRole('combobox',{name:'Office'}), {target:{value:'development'}});
    fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
    expect(screen.getByText('Agente de prueba: CODING')).toBeTruthy();
    rerender(<AgentOffice events={events} />);
    expect(container.querySelector('li[data-agent-id="fixture"]')?.textContent).toBe(original);
    rerender(<AgentOffice events={events} visualMode="crew" />);
    expect((screen.getByRole('combobox',{name:'Office'}) as HTMLSelectElement).value).toBe('development');
    expect(screen.getByText('120%')).toBeTruthy();
  });

  it('aísla dos instancias y sus IDs sin leer ni escribir preferencias globales', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    render(<><AgentOffice visualMode="crew" ariaLabel="Uno" /><AgentOffice visualMode="crew" ariaLabel="Dos" /></>);
    const one = screen.getByRole('region',{name:'Uno'}), two = screen.getByRole('region',{name:'Dos'});
    const first = within(one).getByRole('combobox',{name:'Office'});
    const second = within(two).getByRole('combobox',{name:'Office'});
    expect(first.id).not.toBe(second.id);
    fireEvent.change(first,{target:{value:'development'}});
    fireEvent.click(within(one).getByRole('button',{name:'Zoom in'}));
    expect((second as HTMLSelectElement).value).toBe('ceo');
    expect(within(two).getByText('100%')).toBeTruthy();
    expect(within(one).queryByRole('link')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('notifica al host sin duplicar callbacks en StrictMode y acepta sus cámaras', () => {
    const onChange = vi.fn();
    function Host() {
      const [room, setRoom] = useState('ceo');
      const [cameras, setCameras] = useState<CrewCameraByRoom>({});
      return <AgentOffice visualMode="crew" crewRoomId={room} onCrewRoomChange={setRoom}
        crewCameras={cameras} onCrewCamerasChange={value => { onChange(value); setCameras(value); }} />;
    }
    render(<StrictMode><Host /></StrictMode>);
    fireEvent.change(screen.getByRole('combobox',{name:'Office'}),{target:{value:'development'}});
    fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].development.zoom).toBe(1.2);
    expect(screen.getByText('120%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Reset Crew preferences'}));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toEqual({});
    expect((screen.getByRole('combobox',{name:'Office'}) as HTMLSelectElement).value).toBe('ceo');
  });

  it('respeta props controladas si el host rechaza el cambio y valida entradas corruptas', () => {
    const onRoomChange = vi.fn(), onCameraChange = vi.fn();
    const cameras: CrewCameraByRoom = {ceo:{view:'back',zoom:2,pan:{x:0,y:0}}};
    const {rerender} = render(<AgentOffice visualMode="crew" crewRoomId="ceo" crewCameras={cameras}
      onCrewRoomChange={onRoomChange} onCrewCamerasChange={onCameraChange} />);
    fireEvent.change(screen.getByRole('combobox',{name:'Office'}),{target:{value:'development'}});
    expect(onRoomChange).toHaveBeenCalledWith('development');
    expect((screen.getByRole('combobox',{name:'Office'}) as HTMLSelectElement).value).toBe('ceo');
    fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
    expect(onCameraChange).toHaveBeenCalledTimes(1);
    expect(screen.getByText('200%')).toBeTruthy();
    expect(cameras.ceo.zoom).toBe(2);
    rerender(<AgentOffice visualMode="crew" crewRoomId="removed" crewCameras={{ceo:{view:'back',zoom:NaN,pan:{x:0,y:0}}}} />);
    expect(screen.getByText('100%')).toBeTruthy();
  });
});

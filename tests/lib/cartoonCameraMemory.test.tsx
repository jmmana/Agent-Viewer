import React, { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OfficeCanvas } from '../../src/components/OfficeCanvas';
import { createOfficeTranslator } from '../../src/content/officeMessages';
import type { CameraState } from '../../src/engine/canvasRenderer';

const props = {agents:[],selectedAgentId:null,onSelectAgent:()=>{},activeMeetingId:null,theme:'dark' as const,translate:createOfficeTranslator({locale:'en'})};

describe('Cámara Caricatura al alternar modos', () => {
  it('restaura pan, zoom y orientación sin perderlos bajo StrictMode', () => {
    const memory = {current:{x:42,y:-73,zoom:1.7,rotation:2} as CameraState | null};
    const {unmount} = render(<StrictMode><OfficeCanvas {...props} cameraMemory={memory} /></StrictMode>);
    expect(screen.getByText('170%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
    expect(memory.current).toEqual({x:42,y:-73,zoom:1.7*1.12,rotation:2});
    unmount();
    render(<StrictMode><OfficeCanvas {...props} cameraMemory={memory} /></StrictMode>);
    expect(screen.getByText('190%')).toBeTruthy();
    expect(memory.current).toEqual({x:42,y:-73,zoom:1.7*1.12,rotation:2});
  });
  it('mantiene cámaras diferentes en contenedores distintos', () => {
    const first = {current:{x:10,y:20,zoom:1.5,rotation:1} as CameraState | null};
    const second = {current:{x:0,y:0,zoom:.8,rotation:0} as CameraState | null};
    render(<><OfficeCanvas {...props} cameraMemory={first} /><OfficeCanvas {...props} cameraMemory={second} /></>);
    expect(screen.getByText('150%')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(first.current?.rotation).toBe(1);
    expect(second.current?.rotation).toBe(0);
  });
});

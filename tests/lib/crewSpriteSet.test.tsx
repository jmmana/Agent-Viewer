import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useCrewSprites } from '../../src/crew/useCrewSprite';
import type { CrewView } from '../../src/crew/crewModel';

const {load,stops}=vi.hoisted(()=>({load:vi.fn(),stops:new Map<string,ReturnType<typeof vi.fn>>()}));
vi.mock('../../src/crew/crewSprites',()=>({loadCrewSprite:load}));

it('comparte imágenes por orientación, conserva las requeridas y cancela las que salen',()=>{
  load.mockImplementation((view,ready)=>{
    ready({src:view});const stop=vi.fn();stops.set(view,stop);return stop;
  });
  const {result,rerender,unmount}=renderHook(({views}:{views:CrewView[]})=>useCrewSprites(views),
    {initialProps:{views:['front','front','right'] as CrewView[]}});
  expect(load.mock.calls.map(call=>call[0])).toEqual(['front','right']);
  const right=result.current.images.right;
  act(()=>rerender({views:['right','back']}));
  expect(stops.get('front')).toHaveBeenCalledOnce();
  expect(stops.get('right')).not.toHaveBeenCalled();
  expect(result.current.images.front).toBeUndefined();
  expect(result.current.images.right).toBe(right);
  expect(load.mock.calls.map(call=>call[0])).toEqual(['front','right','back']);
  unmount();
  expect(stops.get('right')).toHaveBeenCalledOnce();
  expect(stops.get('back')).toHaveBeenCalledOnce();
});

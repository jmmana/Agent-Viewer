import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { AgentRole } from '../../src/types/agent';
import { crewRoom } from '../../src/crew/crewModel';
import { projectCrewPresence } from '../../src/crew/crewPresence';
import { useCrewBlink } from '../../src/crew/useCrewBlink';
import {
  CREW_ACCESSORY_OPTIONS,
  CREW_CHARACTER_ROLES,
  CREW_CLOTHING_OPTIONS,
  CREW_FOOTWEAR_OPTIONS,
  CREW_HAIRSTYLE_OPTIONS,
  CREW_SKIN_TONE_OPTIONS,
  type CrewAppearanceCategory,
  type CrewCharacterAppearance,
  crewCatalogOptions,
  defaultCrewCharacterAppearance,
  defaultCrewCharacterRoleFor,
  exportCrewCharacterAppearance,
  importCrewCharacterAppearance,
  validateCrewCharacterAppearance,
} from '../../src/crew/crewCharacterCatalog';
import {
  CREW_CHARACTER_ART_REGISTRY,
  CREW_CHARACTER_CLIPS,
  resolveCrewCharacterView,
  resolveCrewCharacterViews,
  type CrewCharacterArtRegistry,
} from '../../src/crew/crewCharacterArt';
import {
  CREW_CHARACTER_STORAGE_KEY,
  defaultCrewCharacterAppearanceStore,
  getCrewCharacterAppearance,
  readCrewCharacterAppearanceStore,
  resetCrewCharacterAppearance,
  saveCrewCharacterAppearanceStore,
  setCrewCharacterAppearance,
  validateCrewCharacterAppearanceStore,
} from '../../src/crew/crewCharacterStore';
import { useCrewCharacterAppearance } from '../../src/crew/useCrewCharacterAppearance';
import { CrewCharacterEditor } from '../../src/crew/CrewCharacterEditor';

vi.mock('../../src/crew/crewSprites', async importOriginal => ({
  ...await importOriginal<object>(),
  loadCrewImage: vi.fn((_url, _size, ready) => { ready({} as HTMLImageElement); return vi.fn(); }),
}));

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const ROLES: readonly AgentRole[] = ['boss', 'tech_lead', 'research_lead', 'backend_engineer', 'frontend_engineer', 'qa_engineer'];

function combination(index: number): Pick<CrewCharacterAppearance, 'characterRole' | 'hairstyleId' | 'skinToneId' | 'clothingId' | 'footwearId' | 'accessoryId'> {
  return {
    characterRole: CREW_CHARACTER_ROLES[index % CREW_CHARACTER_ROLES.length],
    hairstyleId: CREW_HAIRSTYLE_OPTIONS[index % CREW_HAIRSTYLE_OPTIONS.length].id,
    skinToneId: CREW_SKIN_TONE_OPTIONS[index % CREW_SKIN_TONE_OPTIONS.length].id,
    clothingId: CREW_CLOTHING_OPTIONS[index % CREW_CLOTHING_OPTIONS.length].id,
    footwearId: CREW_FOOTWEAR_OPTIONS[index % CREW_FOOTWEAR_OPTIONS.length].id,
    accessoryId: CREW_ACCESSORY_OPTIONS[index % CREW_ACCESSORY_OPTIONS.length].id,
  };
}

describe('Catálogo de apariencia Crew #127', () => {
  it('expone exactamente los seis arquetipos del contrato visual (#116) con mapeo documentado por rol funcional', () => {
    expect(CREW_CHARACTER_ROLES).toEqual(['ceo', 'analyst', 'developer', 'finance', 'planner', 'reviewer']);
    expect(defaultCrewCharacterRoleFor('boss')).toBe('ceo');
    expect(defaultCrewCharacterRoleFor('qa_engineer')).toBe('reviewer');
    expect(defaultCrewCharacterRoleFor('security_analyst')).toBe('reviewer');
    expect(defaultCrewCharacterRoleFor('custom')).toBe('developer');
  });

  it('matriz paramétrica de 6 roles x 3 combinaciones (18 casos): cada combinación válida hace round-trip exacto', () => {
    let cases = 0;
    for (const role of ROLES) {
      for (let combo = 0; combo < 3; combo++) {
        const chosen = combination(combo + ROLES.indexOf(role));
        const appearance: CrewCharacterAppearance = { version: 1, ...chosen };
        const validated = validateCrewCharacterAppearance(appearance, role);
        expect(validated).toEqual(appearance);
        const serialized = exportCrewCharacterAppearance(validated);
        const imported = importCrewCharacterAppearance(serialized, role);
        expect(imported).toEqual(appearance);
        cases++;
      }
    }
    expect(cases).toBe(18);
  });

  it('una combinación inexistente cae al valor por defecto documentado de cada categoría, nunca a undefined o crash', () => {
    const fallback = defaultCrewCharacterAppearance('backend_engineer');
    const broken = {
      version: 1,
      characterRole: 'nonexistent-role',
      hairstyleId: 'nonexistent-hair',
      skinToneId: 'nonexistent-skin',
      clothingId: 'nonexistent-clothing',
      footwearId: 'nonexistent-footwear',
      accessoryId: 'nonexistent-accessory',
    };
    expect(validateCrewCharacterAppearance(broken, 'backend_engineer')).toEqual(fallback);
    for (const value of [null, undefined, [], 'text', 42, { version: 2 }]) {
      expect(() => validateCrewCharacterAppearance(value, 'backend_engineer')).not.toThrow();
      expect(validateCrewCharacterAppearance(value, 'backend_engineer')).toEqual(fallback);
    }
    // Un solo campo roto no invalida el resto de la apariencia.
    const partial = { ...fallback, hairstyleId: 'nonexistent-hair' };
    expect(validateCrewCharacterAppearance(partial, 'backend_engineer')).toEqual(fallback);
  });

  it('import/export nunca incluye datos del agente y se recupera de texto corrupto', () => {
    const appearance = defaultCrewCharacterAppearance('qa_engineer');
    const serialized = exportCrewCharacterAppearance(appearance);
    const parsed = JSON.parse(serialized);
    expect(Object.keys(parsed).sort()).toEqual(['accessoryId', 'characterRole', 'clothingId', 'footwearId', 'hairstyleId', 'skinToneId', 'version'].sort());
    expect(parsed).not.toHaveProperty('agentId');
    expect(parsed).not.toHaveProperty('name');
    for (const corrupt of ['{', 'x'.repeat(5000), '"just a string"', '[]']) {
      expect(importCrewCharacterAppearance(corrupt, 'qa_engineer')).toEqual(defaultCrewCharacterAppearance('qa_engineer'));
    }
  });
});

describe('Resolución de vistas (honestidad de placeholder) #127', () => {
  it('las 4 vistas son explícitamente placeholder cuando no existe arte real, sin espejar ninguna', () => {
    const appearance = defaultCrewCharacterAppearance('boss');
    const results = resolveCrewCharacterViews(appearance, 'idle');
    expect(results.map(r => r.view)).toEqual(['front', 'right', 'back', 'left']);
    for (const result of results) {
      expect(result.available).toBe(false);
      expect(result.placeholder).toBe(true);
      expect(result.art).toBeUndefined();
    }
    // El registro real empaquetado hoy está vacío: #125/#126 siguen pendientes.
    expect(CREW_CHARACTER_ART_REGISTRY).toEqual({});
  });

  it('una vista con arte registrado se resuelve como disponible sin inventar ni espejar las demás', () => {
    const registry: CrewCharacterArtRegistry = { ceo: { idle: { front: { kind: 'image', moduleId: 'fixture-front' } } } };
    const appearance = defaultCrewCharacterAppearance('boss');
    const front = resolveCrewCharacterView(appearance, 'idle', 'front', registry);
    const right = resolveCrewCharacterView(appearance, 'idle', 'right', registry);
    const back = resolveCrewCharacterView(appearance, 'idle', 'back', registry);
    const left = resolveCrewCharacterView(appearance, 'idle', 'left', registry);
    expect(front).toEqual({ view: 'front', clip: 'idle', available: true, placeholder: false, art: { kind: 'image', moduleId: 'fixture-front' } });
    for (const other of [right, back, left]) {
      expect(other.available).toBe(false);
      expect(other.placeholder).toBe(true);
    }
  });

  it('un clip sin arte propio (walk) es placeholder aunque idle tenga arte en la misma vista', () => {
    const registry: CrewCharacterArtRegistry = { ceo: { idle: { front: { kind: 'image', moduleId: 'fixture-front' } } } };
    const appearance = defaultCrewCharacterAppearance('boss');
    expect(CREW_CHARACTER_CLIPS).toContain('walk');
    const walkFront = resolveCrewCharacterView(appearance, 'walk', 'front', registry);
    expect(walkFront.available).toBe(false);
    expect(walkFront.placeholder).toBe(true);
  });
});

describe('Persistencia por agentId, política #171 #127', () => {
  it('guarda y lee por agentId estable; renombrar el agente no pierde ni mezcla su configuración', () => {
    let store = defaultCrewCharacterAppearanceStore();
    const appearance = { ...defaultCrewCharacterAppearance('boss'), hairstyleId: CREW_HAIRSTYLE_OPTIONS[1].id };
    store = setCrewCharacterAppearance(store, 'agent-1', appearance);
    saveCrewCharacterAppearanceStore(store);
    const reloaded = readCrewCharacterAppearanceStore();
    // El nombre nunca participa en la clave: dos lecturas con nombres distintos para el mismo id dan igual.
    expect(getCrewCharacterAppearance(reloaded, 'agent-1', 'boss')).toEqual(appearance);
    expect(getCrewCharacterAppearance(reloaded, 'agent-1', 'boss')).toEqual(appearance);
  });

  it('un agentId desconocido recibe el valor por defecto de su rol funcional, sin crear entradas fantasma', () => {
    const store = defaultCrewCharacterAppearanceStore();
    expect(getCrewCharacterAppearance(store, 'ghost', 'qa_engineer')).toEqual(defaultCrewCharacterAppearance('qa_engineer'));
    expect(store.byAgentId['ghost']).toBeUndefined();
  });

  it('resetear la configuración de un agente no afecta la de otro agente', () => {
    let store = defaultCrewCharacterAppearanceStore();
    const one = { ...defaultCrewCharacterAppearance('boss'), accessoryId: CREW_ACCESSORY_OPTIONS[2].id };
    const two = { ...defaultCrewCharacterAppearance('qa_engineer'), accessoryId: CREW_ACCESSORY_OPTIONS[1].id };
    store = setCrewCharacterAppearance(store, 'agent-1', one);
    store = setCrewCharacterAppearance(store, 'agent-2', two);
    store = resetCrewCharacterAppearance(store, 'agent-1');
    expect(getCrewCharacterAppearance(store, 'agent-1', 'boss')).toEqual(defaultCrewCharacterAppearance('boss'));
    expect(getCrewCharacterAppearance(store, 'agent-2', 'qa_engineer')).toEqual(two);
  });

  it('recupera versión conocida y valores seguros sin aceptar JSON corrupto, futuro o too-large', () => {
    for (const value of [null, [], { version: 2 }, 'text', 42]) {
      expect(validateCrewCharacterAppearanceStore(value)).toEqual(defaultCrewCharacterAppearanceStore());
    }
    for (const serialized of ['{', 'x'.repeat(100_000)]) {
      localStorage.setItem(CREW_CHARACTER_STORAGE_KEY, serialized);
      expect(readCrewCharacterAppearanceStore()).toEqual(defaultCrewCharacterAppearanceStore());
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('blocked'); });
    expect(readCrewCharacterAppearanceStore()).toEqual(defaultCrewCharacterAppearanceStore());
    expect(() => saveCrewCharacterAppearanceStore(defaultCrewCharacterAppearanceStore())).not.toThrow();
  });

  it('una entrada corrupta dentro del mapa no invalida las entradas válidas de otros agentes', () => {
    localStorage.setItem(CREW_CHARACTER_STORAGE_KEY, JSON.stringify({
      version: 1,
      byAgentId: {
        'agent-good': { version: 1, characterRole: 'ceo', hairstyleId: CREW_HAIRSTYLE_OPTIONS[0].id, skinToneId: CREW_SKIN_TONE_OPTIONS[0].id, clothingId: CREW_CLOTHING_OPTIONS[0].id, footwearId: CREW_FOOTWEAR_OPTIONS[0].id, accessoryId: CREW_ACCESSORY_OPTIONS[0].id },
        'agent-bad': { version: 1, characterRole: 'not-a-role' },
      },
    }));
    const store = readCrewCharacterAppearanceStore();
    expect(getCrewCharacterAppearance(store, 'agent-good', 'boss').characterRole).toBe('ceo');
    expect(getCrewCharacterAppearance(store, 'agent-bad', 'qa_engineer')).toEqual(defaultCrewCharacterAppearance('qa_engineer'));
  });
});

describe('Hook useCrewCharacterAppearance: aislamiento e independencia de posición/animación #127', () => {
  it('persiste por instancia siguiendo el patrón de #171 y aísla entre dos agentes', () => {
    const { result: a } = renderHook(() => useCrewCharacterAppearance('agent-a', 'boss'));
    const { result: b } = renderHook(() => useCrewCharacterAppearance('agent-b', 'qa_engineer'));
    expect(a.current.appearance.characterRole).toBe('ceo');
    expect(b.current.appearance.characterRole).toBe('reviewer');
    act(() => a.current.update({ ...a.current.appearance, clothingId: CREW_CLOTHING_OPTIONS[2].id }));
    expect(b.current.appearance.clothingId).not.toBe(CREW_CLOTHING_OPTIONS[2].id);
  });

  it('cambiar la apariencia de un agente activo en una sala no mueve su posición ni reinicia su clip de animación en curso', () => {
    vi.useFakeTimers();
    const room = crewRoom('ceo')!;
    const agents = [{ id: 'agent-ceo-1', name: 'Uno', status: 'CODING' as const, workspace: 'boss_office' as const, role: 'boss' as const, isWalking: false }];
    const before = projectCrewPresence(agents, room).markers[0];
    const blink = renderHook(() => useCrewBlink(true, 'ceo', false));
    const imageBeforeAppearanceChange = blink.result.current?.image;
    expect(imageBeforeAppearanceChange).toBeDefined();
    // El editor de apariencia vive en un árbol de React totalmente separado
    // (hook y store propios); actualizarlo no debe reiniciar el efecto de
    // carga del clip de parpadeo en curso ni mover al agente de su sitio.
    const { result: appearance } = renderHook(() => useCrewCharacterAppearance('agent-ceo-1', 'boss'));
    act(() => appearance.current.update({ ...appearance.current.appearance, hairstyleId: CREW_HAIRSTYLE_OPTIONS[1].id }));
    act(() => appearance.current.update({ ...appearance.current.appearance, skinToneId: CREW_SKIN_TONE_OPTIONS[2].id }));
    const after = projectCrewPresence(agents, room).markers[0];
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.number).toBe(before.number);
    // Misma referencia de imagen: el efecto de parpadeo no se reinició ni se volvió a cargar.
    expect(blink.result.current?.image).toBe(imageBeforeAppearanceChange);
  });

  it('reset del hook vuelve al valor por defecto del rol funcional sin lanzar', () => {
    const { result } = renderHook(() => useCrewCharacterAppearance('agent-reset', 'planner' as unknown as AgentRole));
    act(() => result.current.update({ ...result.current.appearance, accessoryId: CREW_ACCESSORY_OPTIONS[3].id }));
    expect(result.current.appearance.accessoryId).toBe(CREW_ACCESSORY_OPTIONS[3].id);
    act(() => result.current.reset());
    expect(result.current.appearance).toEqual(defaultCrewCharacterAppearance('planner' as unknown as AgentRole));
  });
});

describe('CrewCharacterEditor: operabilidad por teclado y contrato de UI #127', () => {
  function Harness({ agentId, functionalRole, isEs = false }: { agentId: string; functionalRole: AgentRole; isEs?: boolean }) {
    const character = useCrewCharacterAppearance(agentId, functionalRole);
    return <CrewCharacterEditor
      agentId={agentId}
      functionalRole={functionalRole}
      appearance={character.appearance}
      onChange={character.update}
      onReset={character.reset}
      isEs={isEs}
      idPrefix="editor-test"
    />;
  }

  it('cada opción del catálogo es alcanzable por foco/tab sin mouse', () => {
    render(<Harness agentId="agent-kb" functionalRole="boss" />);
    const focusables = [
      screen.getByRole('combobox', { name: 'Character' }),
      screen.getByRole('combobox', { name: 'Hairstyle' }),
      screen.getByRole('combobox', { name: 'Skin tone' }),
      screen.getByRole('combobox', { name: 'Clothing' }),
      screen.getByRole('combobox', { name: 'Footwear' }),
      screen.getByRole('combobox', { name: 'Accessory' }),
      screen.getByRole('button', { name: 'Reset appearance' }),
    ];
    for (const element of focusables) {
      expect((element as HTMLElement).hasAttribute('disabled')).toBe(false);
      expect(element.getAttribute('tabindex')).not.toBe('-1');
      (element as HTMLElement).focus();
      expect(document.activeElement).toBe(element);
    }
  });

  it('cambiar cada select notifica onChange con la apariencia completa sin mutar la anterior', () => {
    const onChange = vi.fn();
    const appearance = defaultCrewCharacterAppearance('boss');
    render(<CrewCharacterEditor agentId="agent-x" functionalRole="boss" appearance={appearance} onChange={onChange} onReset={vi.fn()} isEs={false} idPrefix="editor-test" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Hairstyle' }), { target: { value: CREW_HAIRSTYLE_OPTIONS[2].id } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...appearance, hairstyleId: CREW_HAIRSTYLE_OPTIONS[2].id });
    expect(appearance.hairstyleId).toBe(CREW_HAIRSTYLE_OPTIONS[0].id);
  });

  it('botón de reset invoca onReset explícitamente, sin adivinar el valor por defecto en el componente', () => {
    const onReset = vi.fn();
    render(<CrewCharacterEditor agentId="agent-x" functionalRole="boss" appearance={defaultCrewCharacterAppearance('boss')} onChange={vi.fn()} onReset={onReset} isEs={false} idPrefix="editor-test" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset appearance' }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('muestra las 4 vistas (frente/espalda/izquierda/derecha) marcadas honestamente como placeholder, en español e inglés', () => {
    const appearance = defaultCrewCharacterAppearance('boss');
    const { rerender } = render(<CrewCharacterEditor agentId="agent-x" functionalRole="boss" appearance={appearance} onChange={vi.fn()} onReset={vi.fn()} isEs={false} idPrefix="editor-test" />);
    for (const label of ['Front', 'Right', 'Back', 'Left']) {
      expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(/placeholder/i).length).toBe(4);
    rerender(<CrewCharacterEditor agentId="agent-x" functionalRole="boss" appearance={appearance} onChange={vi.fn()} onReset={vi.fn()} isEs idPrefix="editor-test" />);
    for (const label of ['Frente', 'Derecha', 'Atrás', 'Izquierda']) {
      expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
    }
  });

  it('cada opción de la selección de personaje corresponde a uno de los seis arquetipos del catálogo', () => {
    render(<CrewCharacterEditor agentId="agent-x" functionalRole="boss" appearance={defaultCrewCharacterAppearance('boss')} onChange={vi.fn()} onReset={vi.fn()} isEs={false} idPrefix="editor-test" />);
    const select = screen.getByRole('combobox', { name: 'Character' }) as HTMLSelectElement;
    const values = within(select).getAllByRole('option').map(o => (o as HTMLOptionElement).value);
    expect(values.sort()).toEqual([...CREW_CHARACTER_ROLES].sort());
  });

  it('cada categoría del catálogo expone exactamente las opciones registradas, sin inventar ninguna', () => {
    render(<CrewCharacterEditor agentId="agent-x" functionalRole="boss" appearance={defaultCrewCharacterAppearance('boss')} onChange={vi.fn()} onReset={vi.fn()} isEs={false} idPrefix="editor-test" />);
    const checks: [string, CrewAppearanceCategory][] = [
      ['Hairstyle', 'hairstyle'],
      ['Skin tone', 'skinTone'],
      ['Clothing', 'clothing'],
      ['Footwear', 'footwear'],
      ['Accessory', 'accessory'],
    ];
    for (const [name, category] of checks) {
      const select = screen.getByRole('combobox', { name }) as HTMLSelectElement;
      const values = within(select).getAllByRole('option').map(o => (o as HTMLOptionElement).value);
      expect(values).toEqual(crewCatalogOptions(category).map(o => o.id));
    }
  });
});

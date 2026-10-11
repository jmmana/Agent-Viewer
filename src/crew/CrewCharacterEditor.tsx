import React from 'react';
import type { AgentRole } from '../types/agent';
import { CREW_VIEWS, type CrewView } from './crewModel';
import {
  CREW_ACCESSORY_OPTIONS,
  CREW_CHARACTER_ROLES,
  CREW_CHARACTER_ROLE_LABELS,
  CREW_CLOTHING_OPTIONS,
  CREW_FOOTWEAR_OPTIONS,
  CREW_HAIRSTYLE_OPTIONS,
  CREW_SKIN_TONE_OPTIONS,
  type CrewCatalogOption,
  type CrewCharacterAppearance,
  type CrewCharacterRole,
} from './crewCharacterCatalog';
import { resolveCrewCharacterViews } from './crewCharacterArt';

const VIEW_LABELS: Readonly<Record<CrewView, { en: string; es: string }>> = {
  front: { en: 'Front', es: 'Frente' },
  right: { en: 'Right', es: 'Derecha' },
  back: { en: 'Back', es: 'Atrás' },
  left: { en: 'Left', es: 'Izquierda' },
};

/**
 * Editor de apariencia visual Crew (issue #127). Opera sobre el catálogo
 * placeholder de #127 mientras #125 (variantes por rol) y #126 (biblioteca
 * modular) no existan: nunca activa una ruta de imagen que no exista. Solo
 * apariencia: nunca cambia el rol funcional, las tareas, el costo ni ningún
 * otro dato del agente (`functionalRole`/`agentId` solo identifican a quién
 * pertenece esta apariencia, nunca se escriben aquí).
 */
export function CrewCharacterEditor({ agentId, functionalRole, appearance, onChange, onReset, isEs, idPrefix }: {
  agentId: string;
  functionalRole: AgentRole;
  appearance: CrewCharacterAppearance;
  onChange: (next: CrewCharacterAppearance) => void;
  onReset: () => void;
  isEs: boolean;
  idPrefix: string;
}) {
  const views = resolveCrewCharacterViews(appearance, 'idle');
  const field = (
    category: 'hairstyle' | 'skinTone' | 'clothing' | 'footwear' | 'accessory',
    labelEn: string,
    labelEs: string,
    options: readonly CrewCatalogOption[],
    value: string,
    onPick: (id: string) => void,
  ) => {
    const id = `${idPrefix}-character-${category}`;
    return <React.Fragment key={category}>
      <label htmlFor={id}>{isEs ? labelEs : labelEn}</label>
      <select id={id} value={value} onChange={event => onPick(event.target.value)}>
        {options.map(item => <option key={item.id} value={item.id}>{isEs ? item.label.es : item.label.en}</option>)}
      </select>
    </React.Fragment>;
  };

  return <section aria-label={isEs ? `Editor de apariencia Crew de ${agentId}` : `Crew appearance editor for ${agentId}`}>
    <label htmlFor={`${idPrefix}-character-role`}>{isEs ? 'Personaje' : 'Character'}</label>
    <select id={`${idPrefix}-character-role`} value={appearance.characterRole}
      onChange={event => onChange({ ...appearance, characterRole: event.target.value as CrewCharacterRole })}>
      {CREW_CHARACTER_ROLES.map(role => <option key={role} value={role}>
        {isEs ? CREW_CHARACTER_ROLE_LABELS[role].es : CREW_CHARACTER_ROLE_LABELS[role].en}
      </option>)}
    </select>

    {field('hairstyle', 'Hairstyle', 'Cabello', CREW_HAIRSTYLE_OPTIONS, appearance.hairstyleId, id => onChange({ ...appearance, hairstyleId: id }))}
    {field('skinTone', 'Skin tone', 'Piel', CREW_SKIN_TONE_OPTIONS, appearance.skinToneId, id => onChange({ ...appearance, skinToneId: id }))}
    {field('clothing', 'Clothing', 'Prenda', CREW_CLOTHING_OPTIONS, appearance.clothingId, id => onChange({ ...appearance, clothingId: id }))}
    {field('footwear', 'Footwear', 'Calzado', CREW_FOOTWEAR_OPTIONS, appearance.footwearId, id => onChange({ ...appearance, footwearId: id }))}
    {field('accessory', 'Accessory', 'Accesorio', CREW_ACCESSORY_OPTIONS, appearance.accessoryId, id => onChange({ ...appearance, accessoryId: id }))}

    <button type="button" onClick={onReset}>{isEs ? 'Restablecer apariencia' : 'Reset appearance'}</button>

    <div aria-label={isEs ? 'Vista previa de 4 lados' : '4-side preview'}>
      {views.map(result => (
        <p key={result.view} data-testid={`${idPrefix}-character-view-${result.view}`}>
          {isEs ? VIEW_LABELS[result.view].es : VIEW_LABELS[result.view].en}
          {': '}
          {result.placeholder
            ? (isEs ? 'marcador (placeholder), sin arte real todavía' : 'placeholder, no real art yet')
            : (isEs ? 'arte real disponible' : 'real art available')}
        </p>
      ))}
    </div>
  </section>;
}

import { CREW_VIEWS, type CrewView } from './crewModel';
import type { CrewCharacterAppearance, CrewCharacterRole } from './crewCharacterCatalog';

/**
 * Escenas de movimiento del editor de personajes. Hoy son solo nombres de
 * contrato: ningún rol tiene arte por clip todavía (#125/#126 pendientes).
 */
export type CrewCharacterClip = 'idle' | 'walk';
export const CREW_CHARACTER_CLIPS: readonly CrewCharacterClip[] = ['idle', 'walk'];

/** Referencia opaca a un recurso de arte real, para cuando #125/#126 lo agreguen. */
export interface CrewCharacterArtRef {
  kind: 'image';
  moduleId: string;
}

/**
 * Registro de arte real por arquetipo, clip y vista. Cada entrada es
 * independiente: nunca se deriva una vista a partir de otra (issue #127,
 * "si falta vista o variante, placeholder honesto, no espejo engañoso").
 */
export type CrewCharacterArtRegistry = Partial<Record<CrewCharacterRole, Partial<Record<CrewCharacterClip, Partial<Record<CrewView, CrewCharacterArtRef>>>>>>;

/**
 * Vacío a propósito: #125 (variantes de apariencia por rol) y #126
 * (biblioteca modular de cabello/piel/vestuario/accesorios) siguen
 * pendientes, sin ningún catálogo ni arte real todavía. No se activa
 * ninguna ruta de imagen que no exista.
 */
export const CREW_CHARACTER_ART_REGISTRY: CrewCharacterArtRegistry = {};

export interface CrewCharacterViewResult {
  view: CrewView;
  clip: CrewCharacterClip;
  available: boolean;
  placeholder: boolean;
  art?: CrewCharacterArtRef;
}

/**
 * Resuelve una sola vista/clip contra el registro de arte real. Si no existe
 * arte para esa combinación exacta, devuelve un placeholder explícito; nunca
 * reutiliza la imagen de otra vista o clip como sustituto.
 */
export function resolveCrewCharacterView(
  appearance: CrewCharacterAppearance,
  clip: CrewCharacterClip,
  view: CrewView,
  registry: CrewCharacterArtRegistry = CREW_CHARACTER_ART_REGISTRY,
): CrewCharacterViewResult {
  const art = registry[appearance.characterRole]?.[clip]?.[view];
  return art ? { view, clip, available: true, placeholder: false, art } : { view, clip, available: false, placeholder: true };
}

/** Resuelve las 4 vistas (frente/derecha/espalda/izquierda) para un clip dado, en el mismo orden que la cámara de la sala (#156). */
export function resolveCrewCharacterViews(
  appearance: CrewCharacterAppearance,
  clip: CrewCharacterClip,
  registry: CrewCharacterArtRegistry = CREW_CHARACTER_ART_REGISTRY,
): readonly CrewCharacterViewResult[] {
  return CREW_VIEWS.map(view => resolveCrewCharacterView(appearance, clip, view, registry));
}

import type { AgentRole } from '../types/agent';

/**
 * Los seis arquetipos ilustrados del contrato visual Crew (#116, sección 6:
 * "Los seis roles"): `ceo`, `analyst`, `developer`, `finance`, `planner`,
 * `reviewer`. Esto es DISTINTO del `AgentRole` funcional del dominio
 * (`boss`, `tech_lead`, etc.): es un disfraz cosmético que un agente puede
 * elegir libremente en el editor sin que eso cambie su rol funcional, sus
 * tareas, su costo ni ningún otro dato del agente (issue #127).
 */
export type CrewCharacterRole = 'ceo' | 'analyst' | 'developer' | 'finance' | 'planner' | 'reviewer';
export const CREW_CHARACTER_ROLES: readonly CrewCharacterRole[] = ['ceo', 'analyst', 'developer', 'finance', 'planner', 'reviewer'];

export const CREW_CHARACTER_ROLE_LABELS: Readonly<Record<CrewCharacterRole, { en: string; es: string }>> = {
  ceo: { en: 'CEO', es: 'Dirección' },
  analyst: { en: 'Analyst', es: 'Analista' },
  developer: { en: 'Developer', es: 'Desarrollador' },
  finance: { en: 'Finance', es: 'Finanzas' },
  planner: { en: 'Planner', es: 'Planificador' },
  reviewer: { en: 'Reviewer', es: 'Revisor' },
};

/**
 * Sugerencia inicial de disfraz según el rol funcional real del agente. Es
 * solo el valor por defecto: el editor permite elegir cualquiera de los seis
 * sin restricción, porque #125/#126 (variantes de apariencia por rol real)
 * todavía no existen y no hay ninguna razón técnica hoy para bloquear la
 * combinación. Documentado explícitamente para que el mapeo no se adivine.
 */
const DEFAULT_CHARACTER_ROLE_BY_FUNCTIONAL_ROLE: Readonly<Record<AgentRole, CrewCharacterRole>> = {
  boss: 'ceo',
  tech_lead: 'planner',
  research_lead: 'analyst',
  backend_engineer: 'developer',
  frontend_engineer: 'developer',
  qa_engineer: 'reviewer',
  security_analyst: 'reviewer',
  // Sin arquetipo propio todavía: se usa un valor neutro documentado, nunca
  // uno aleatorio ni indefinido.
  custom: 'developer',
};

export function defaultCrewCharacterRoleFor(functionalRole: AgentRole): CrewCharacterRole {
  return DEFAULT_CHARACTER_ROLE_BY_FUNCTIONAL_ROLE[functionalRole] ?? 'developer';
}

export type CrewAppearanceCategory = 'hairstyle' | 'skinTone' | 'clothing' | 'footwear' | 'accessory';

export interface CrewCatalogOption {
  id: string;
  category: CrewAppearanceCategory;
  label: { en: string; es: string };
  /**
   * Único valor posible hoy: ningún elemento de este catálogo tiene arte real
   * todavía (#125/#126 siguen pendientes, ver docs/crew/IMPLEMENTATION-STATUS.md).
   * El campo existe para que una futura variante con arte real sea un cambio
   * de dato, no de contrato.
   */
  status: 'placeholder';
}

function option(category: CrewAppearanceCategory, id: string, en: string, es: string): CrewCatalogOption {
  return { id, category, label: { en, es }, status: 'placeholder' };
}

export const CREW_HAIRSTYLE_OPTIONS: readonly CrewCatalogOption[] = [
  option('hairstyle', 'hairstyle-short', 'Short', 'Corto'),
  option('hairstyle', 'hairstyle-long', 'Long', 'Largo'),
  option('hairstyle', 'hairstyle-bald', 'Bald', 'Sin cabello'),
];

export const CREW_SKIN_TONE_OPTIONS: readonly CrewCatalogOption[] = [
  option('skinTone', 'skin-light', 'Light', 'Clara'),
  option('skinTone', 'skin-medium', 'Medium', 'Media'),
  option('skinTone', 'skin-deep', 'Deep', 'Oscura'),
];

export const CREW_CLOTHING_OPTIONS: readonly CrewCatalogOption[] = [
  option('clothing', 'clothing-suit', 'Suit', 'Traje'),
  option('clothing', 'clothing-casual', 'Casual jacket', 'Chamarra casual'),
  option('clothing', 'clothing-vest', 'Vest', 'Chaleco'),
];

export const CREW_FOOTWEAR_OPTIONS: readonly CrewCatalogOption[] = [
  option('footwear', 'footwear-formal', 'Formal shoes', 'Zapatos formales'),
  option('footwear', 'footwear-casual', 'Casual shoes', 'Zapatos casuales'),
];

export const CREW_ACCESSORY_OPTIONS: readonly CrewCatalogOption[] = [
  option('accessory', 'accessory-none', 'None', 'Ninguno'),
  option('accessory', 'accessory-glasses', 'Glasses', 'Lentes'),
  option('accessory', 'accessory-headphones', 'Headphones', 'Audífonos'),
  option('accessory', 'accessory-badge', 'Badge', 'Gafete'),
];

const CATALOG_BY_CATEGORY: Readonly<Record<CrewAppearanceCategory, readonly CrewCatalogOption[]>> = {
  hairstyle: CREW_HAIRSTYLE_OPTIONS,
  skinTone: CREW_SKIN_TONE_OPTIONS,
  clothing: CREW_CLOTHING_OPTIONS,
  footwear: CREW_FOOTWEAR_OPTIONS,
  accessory: CREW_ACCESSORY_OPTIONS,
};

export function crewCatalogOptions(category: CrewAppearanceCategory): readonly CrewCatalogOption[] {
  return CATALOG_BY_CATEGORY[category];
}

export function isKnownCrewCatalogOption(category: CrewAppearanceCategory, id: unknown): id is string {
  return typeof id === 'string' && CATALOG_BY_CATEGORY[category].some(item => item.id === id);
}

/**
 * La apariencia visual completa y versionada de un agente. Nunca contiene el
 * rol funcional, el nombre, el costo ni ningún otro dato de dominio: solo lo
 * puramente cosmético (issue #127, "nunca cambia tareas, roles funcionales,
 * costes o datos del agente").
 */
export interface CrewCharacterAppearance {
  version: 1;
  characterRole: CrewCharacterRole;
  hairstyleId: string;
  skinToneId: string;
  clothingId: string;
  footwearId: string;
  accessoryId: string;
}

export function defaultCrewCharacterAppearance(functionalRole: AgentRole = 'custom'): CrewCharacterAppearance {
  return {
    version: 1,
    characterRole: defaultCrewCharacterRoleFor(functionalRole),
    hairstyleId: CREW_HAIRSTYLE_OPTIONS[0].id,
    skinToneId: CREW_SKIN_TONE_OPTIONS[0].id,
    clothingId: CREW_CLOTHING_OPTIONS[0].id,
    footwearId: CREW_FOOTWEAR_OPTIONS[0].id,
    accessoryId: CREW_ACCESSORY_OPTIONS[0].id,
  };
}

/**
 * Cada campo se valida de forma independiente: un id desconocido o corrupto
 * en una sola categoría nunca invalida toda la apariencia ni produce un
 * estado indefinido. Cae exactamente al valor por defecto documentado de esa
 * categoría (issue #127, "una combinación inexistente... cae a un valor por
 * defecto documentado, nunca un estado indefinido o un crash").
 */
export function validateCrewCharacterAppearance(value: unknown, functionalRole: AgentRole = 'custom'): CrewCharacterAppearance {
  const fallback = defaultCrewCharacterAppearance(functionalRole);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return fallback;
  return {
    version: 1,
    characterRole: CREW_CHARACTER_ROLES.includes(record.characterRole as CrewCharacterRole)
      ? (record.characterRole as CrewCharacterRole) : fallback.characterRole,
    hairstyleId: isKnownCrewCatalogOption('hairstyle', record.hairstyleId) ? record.hairstyleId : fallback.hairstyleId,
    skinToneId: isKnownCrewCatalogOption('skinTone', record.skinToneId) ? record.skinToneId : fallback.skinToneId,
    clothingId: isKnownCrewCatalogOption('clothing', record.clothingId) ? record.clothingId : fallback.clothingId,
    footwearId: isKnownCrewCatalogOption('footwear', record.footwearId) ? record.footwearId : fallback.footwearId,
    accessoryId: isKnownCrewCatalogOption('accessory', record.accessoryId) ? record.accessoryId : fallback.accessoryId,
  };
}

/**
 * Validación estricta, sin relleno por defecto: usada por el almacén
 * (`crewCharacterStore.ts`) para decidir si una entrada guardada es
 * confiable tal cual. Una entrada que falla aquí se descarta por completo en
 * vez de normalizarse a medias, para que el agente reciba el valor por
 * defecto correcto de su rol funcional real en la siguiente lectura, en vez
 * de quedar con un remiendo basado en un rol funcional desconocido.
 */
export function isFullyValidCrewCharacterAppearance(value: unknown): value is CrewCharacterAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && CREW_CHARACTER_ROLES.includes(record.characterRole as CrewCharacterRole)
    && isKnownCrewCatalogOption('hairstyle', record.hairstyleId)
    && isKnownCrewCatalogOption('skinTone', record.skinToneId)
    && isKnownCrewCatalogOption('clothing', record.clothingId)
    && isKnownCrewCatalogOption('footwear', record.footwearId)
    && isKnownCrewCatalogOption('accessory', record.accessoryId);
}

const EXPORT_FIELDS = ['version', 'characterRole', 'hairstyleId', 'skinToneId', 'clothingId', 'footwearId', 'accessoryId'] as const;

/**
 * Exporta solo los campos cosméticos de la apariencia, nunca el id, nombre
 * ni ningún otro dato del agente (issue #127, "import/export seguro").
 */
export function exportCrewCharacterAppearance(appearance: CrewCharacterAppearance): string {
  const safe = validateCrewCharacterAppearance(appearance);
  const ordered: Record<string, unknown> = {};
  for (const field of EXPORT_FIELDS) ordered[field] = safe[field];
  return JSON.stringify(ordered);
}

/** Nunca confía en el texto importado: lo valida exactamente como una lectura de almacenamiento. */
export function importCrewCharacterAppearance(serialized: string, functionalRole: AgentRole = 'custom'): CrewCharacterAppearance {
  if (typeof serialized !== 'string' || serialized.length > 4096) return defaultCrewCharacterAppearance(functionalRole);
  try {
    return validateCrewCharacterAppearance(JSON.parse(serialized), functionalRole);
  } catch {
    return defaultCrewCharacterAppearance(functionalRole);
  }
}

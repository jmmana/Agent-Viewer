/**
 * Manifiesto de audio propio de Crew (#150), independiente del motor de sonido de
 * Caricatura (`src/engine/soundEffects.ts`): comparten la técnica (Web Audio API
 * sintetizada) pero no código, estado ni preferencia.
 *
 * Ningún sonido de este manifiesto es una muestra grabada de terceros: todo se
 * genera en tiempo real con osciladores y envolventes de ganancia, así que no hay
 * archivo de audio que licenciar. El origen y la licencia de cada sonido se
 * documentan aquí, como pide el criterio de aceptación de #150, y también en
 * `docs/crew/AUDIO_LICENSES.md` para quien busque la licencia sin leer código.
 *
 * Son marcadores de posición deliberados: #150 no define la dirección de arte de
 * audio final del producto. Un reemplazo futuro por pistas grabadas o compradas
 * deberá traer su propia licencia verificable a este mismo manifiesto.
 */

/** Pistas de música de fondo (loop). Hoy solo existe una, para la sala de descanso. */
export type CrewAudioTrackId = 'lounge-ambient';
/** Efectos cortos de un solo disparo (feedback visual-sonoro). */
export type CrewAudioCueId = 'ui-notification';

export interface CrewAudioAssetInfo {
  id: CrewAudioTrackId | CrewAudioCueId;
  kind: 'music' | 'cue';
  label: { en: string; es: string };
  origin: string;
  license: string;
  notes: { en: string; es: string };
}

export const CREW_AUDIO_MANIFEST: readonly CrewAudioAssetInfo[] = [
  {
    id: 'lounge-ambient',
    kind: 'music',
    label: { en: 'Lounge ambient loop', es: 'Loop ambiental de la sala de descanso' },
    origin: 'Sintetizado por el motor de Crew con osciladores Web Audio API (sin muestras grabadas ni archivos de audio).',
    license: 'CC0 / dominio público: código propio del repositorio, sin IP de terceros.',
    notes: {
      en: 'Placeholder for #150: a soft four-chord arpeggio loop, not final art direction. A future issue can replace it with licensed or commissioned music if the product needs one.',
      es: 'Marcador de posición de #150: un arpegio suave de cuatro acordes en bucle, no es dirección de arte definitiva. Un issue futuro puede reemplazarlo por música con licencia o encargada si el producto lo necesita.',
    },
  },
  {
    id: 'ui-notification',
    kind: 'cue',
    label: { en: 'Short notification blip', es: 'Aviso corto de notificación' },
    origin: 'Sintetizado por el motor de Crew: un oscilador senoidal con una envolvente corta.',
    license: 'CC0 / dominio público: código propio del repositorio, sin IP de terceros.',
    notes: {
      en: 'Generic visual+sound feedback cue, reusable by any room through the engine. The phone ring (#145) and the coffee sound (#146) are separate issues; neither is wired to a room yet.',
      es: 'Aviso genérico de retroalimentación visual y sonora, reutilizable por cualquier sala a través del motor. La señal de teléfono (#145) y el sonido de café (#146) son issues aparte; ninguno está conectado a una sala todavía.',
    },
  },
] as const;

/**
 * Qué pista de fondo corresponde a cada sala (`CREW_ROOMS` en `crewModel.ts`).
 * `null` significa silencio en esa sala: así se evita, por diseño, que la música
 * de la sala de descanso suene por accidente en QA o en Dirección.
 */
export const CREW_ROOM_MUSIC: Readonly<Record<string, CrewAudioTrackId | null>> = {
  ceo: null,
  development: null,
  planning: null,
  research: null,
  qa: null,
  finance: null,
  meeting: null,
  infrastructure: null,
  coffee: null,
  lounge: 'lounge-ambient',
  reception: null,
};

export function crewAudioAssetInfo(id: CrewAudioTrackId | CrewAudioCueId): CrewAudioAssetInfo {
  const info = CREW_AUDIO_MANIFEST.find(item => item.id === id);
  if (!info) throw new Error(`Sonido de Crew sin entrada en el manifiesto: ${id}`);
  return info;
}

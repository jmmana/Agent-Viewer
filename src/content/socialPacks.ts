import type { AgentMood, SocialTopic } from '../types/agent';
/** Languages with built-in simulated social lines. */
export type SocialLocale = 'en' | 'es';

export interface SocialLine {
  text: string;
  mood: AgentMood;
}

export interface SocialExchange {
  topic: SocialTopic | 'politics';
  lines: [SocialLine, SocialLine];
}

const en: SocialExchange[] = [
  {
    topic: 'jokes',
    lines: [
      { text: 'Why did the developer go broke? Too many cache misses.', mood: 'amused' },
      { text: 'That joke needs a hotfix, but I laughed anyway.', mood: 'happy' },
    ],
  },
  {
    topic: 'jokes',
    lines: [
      { text: 'I told the API a secret. It returned 401.', mood: 'amused' },
      { text: 'Good. At least somebody respects boundaries around here.', mood: 'happy' },
    ],
  },
  {
    topic: 'sports',
    lines: [
      { text: 'That last match was chaos. I need a replay and coffee.', mood: 'excited' },
      { text: 'No spoilers. I still have it queued for later.', mood: 'annoyed' },
    ],
  },
  {
    topic: 'technology',
    lines: [
      { text: 'Another model launch. My benchmark spreadsheet is crying.', mood: 'surprised' },
      { text: 'Wake me when the latency chart stops looking like a mountain range.', mood: 'tired' },
    ],
  },
  {
    topic: 'entertainment',
    lines: [
      { text: 'I finally watched the series everyone keeps quoting.', mood: 'happy' },
      { text: 'And now half the office jokes make sense, right?', mood: 'amused' },
    ],
  },
  {
    topic: 'current_events',
    lines: [
      { text: 'I saw a big headline this morning. I am waiting for reliable sources before forming an opinion.', mood: 'focused' },
      { text: 'Same. Fast news is not always good news.', mood: 'neutral' },
    ],
  },
  {
    topic: 'office_banter',
    lines: [
      { text: 'Who changed the coffee strength to “production incident”?', mood: 'surprised' },
      { text: 'That was me. You are welcome.', mood: 'amused' },
    ],
  },
  {
    topic: 'politics',
    lines: [
      { text: 'Politics is moving fast again. I am not betting on a headline before the facts settle.', mood: 'focused' },
      { text: 'Agreed. Sources first, arguments second.', mood: 'neutral' },
    ],
  },
];

const es: SocialExchange[] = [
  {
    topic: 'jokes',
    lines: [
      { text: '¿Por qué el desarrollador quedó sin plata? Por demasiados cache misses.', mood: 'amused' },
      { text: 'Ese chiste necesita hotfix, pero igual me reí.', mood: 'happy' },
    ],
  },
  {
    topic: 'jokes',
    lines: [
      { text: 'Le conté un secreto al API y me respondió 401.', mood: 'amused' },
      { text: 'Bien. Por lo menos alguien respeta los límites aquí.', mood: 'happy' },
    ],
  },
  {
    topic: 'sports',
    lines: [
      { text: 'Ese último partido fue una locura. Necesito repetición y café.', mood: 'excited' },
      { text: 'Sin spoilers. Todavía lo tengo pendiente.', mood: 'annoyed' },
    ],
  },
  {
    topic: 'technology',
    lines: [
      { text: 'Otro modelo nuevo. Mi hoja de benchmarks está llorando.', mood: 'surprised' },
      { text: 'Me avisas cuando la gráfica de latencia deje de parecer una montaña.', mood: 'tired' },
    ],
  },
  {
    topic: 'entertainment',
    lines: [
      { text: 'Por fin vi la serie que todo el mundo cita.', mood: 'happy' },
      { text: 'Entonces ya entiendes la mitad de los chistes de la oficina.', mood: 'amused' },
    ],
  },
  {
    topic: 'current_events',
    lines: [
      { text: 'Vi un titular fuerte esta mañana. Prefiero esperar fuentes confiables antes de opinar.', mood: 'focused' },
      { text: 'Igual yo. Rápido no siempre significa correcto.', mood: 'neutral' },
    ],
  },
  {
    topic: 'office_banter',
    lines: [
      { text: '¿Quién cambió la intensidad del café a “incidente en producción”?', mood: 'surprised' },
      { text: 'Yo. De nada.', mood: 'amused' },
    ],
  },
  {
    topic: 'politics',
    lines: [
      { text: 'La política está movida otra vez. Prefiero esperar hechos confirmados antes de discutir titulares.', mood: 'focused' },
      { text: 'De acuerdo. Primero fuentes, después opiniones.', mood: 'neutral' },
    ],
  },
];

export function socialPack(locale: SocialLocale): SocialExchange[] {
  return locale === 'es' ? es : en;
}

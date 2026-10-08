import { describe, expect, it } from 'vitest';
import {
  OFFICE_MESSAGES,
  builtInMessages,
  createOfficeTranslator,
  formatMessage,
  isOfficeMessageKey,
  type OfficeMessageKey,
} from '../../src/lib/index';

const en = OFFICE_MESSAGES.en;
const es = OFFICE_MESSAGES.es;
const keys = Object.keys(en) as OfficeMessageKey[];

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe('message catalogs', () => {
  it('has a Spanish text for every English key', () => {
    const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(es, key));
    expect(missing).toEqual([]);
  });

  it('has no Spanish key without an English one', () => {
    const extra = Object.keys(es).filter((key) => !Object.prototype.hasOwnProperty.call(en, key));
    expect(extra).toEqual([]);
  });

  it.each(keys)('%s has a non-empty value in both languages', (key) => {
    expect(typeof en[key]).toBe('string');
    expect(typeof es[key]).toBe('string');
    expect(en[key].trim()).not.toBe('');
    expect(es[key].trim()).not.toBe('');
  });

  it.each(keys)('%s uses the same placeholders in both languages', (key) => {
    expect(placeholders(es[key])).toEqual(placeholders(en[key]));
  });

  it('never uses the em dash character', () => {
    const offenders = [...keys.map((key) => en[key]), ...keys.map((key) => es[key])].filter((text) => text.includes('—'));
    expect(offenders).toEqual([]);
  });

  it('recognises catalog keys only', () => {
    expect(isOfficeMessageKey('status.THINKING')).toBe(true);
    expect(isOfficeMessageKey('status.SLEEPING')).toBe(false);
    expect(isOfficeMessageKey('toString')).toBe(false);
    expect(isOfficeMessageKey('__proto__')).toBe(false);
  });
});

describe('formatMessage', () => {
  it('replaces known placeholders and keeps unknown ones', () => {
    expect(formatMessage('{name}, {role}: {status}', { name: 'Ana', role: 'Planner', status: 'Idle' })).toBe('Ana, Planner: Idle');
    expect(formatMessage('Zoom {percent}%', { percent: 110 })).toBe('Zoom 110%');
    expect(formatMessage('{name} at {place}', { name: 'Ana' })).toBe('Ana at {place}');
    expect(formatMessage('Hello {name}')).toBe('Hello {name}');
  });

  it('does not read placeholders from the object prototype', () => {
    expect(formatMessage('{toString}', {})).toBe('{toString}');
  });
});

describe('createOfficeTranslator', () => {
  it('picks the catalog by language and falls back to English for other languages', () => {
    expect(builtInMessages('es-MX')).toBe(es);
    expect(builtInMessages('ES')).toBe(es);
    expect(builtInMessages('fr')).toBe(en);
    expect(builtInMessages(undefined)).toBe(en);
    expect(createOfficeTranslator({ locale: 'es-AR' })('status.THINKING')).toBe('Pensando');
    expect(createOfficeTranslator({ locale: 'pt-BR' })('status.THINKING')).toBe('Thinking');
    expect(createOfficeTranslator()('status.THINKING')).toBe('Thinking');
  });

  it('applies message overrides key by key', () => {
    const translate = createOfficeTranslator({ locale: 'es', messages: { 'status.IDLE': 'Libre' } });
    expect(translate('status.IDLE')).toBe('Libre');
    expect(translate('status.DONE')).toBe('Terminado');
  });

  it('formats placeholders in overrides', () => {
    const translate = createOfficeTranslator({ locale: 'es', messages: { 'office.agentLine': '{status} · {name}' } });
    expect(translate('office.agentLine', { name: 'Ana', role: 'x', status: 'Pensando' })).toBe('Pensando · Ana');
  });

  it('lets the host translate function win when it returns a real value', () => {
    const translate = createOfficeTranslator({
      locale: 'es',
      messages: { 'status.IDLE': 'Libre' },
      t: (key) => (key === 'status.IDLE' ? 'Disponible para tareas' : undefined),
    });
    expect(translate('status.IDLE')).toBe('Disponible para tareas');
    expect(translate('status.DONE')).toBe('Terminado');
  });

  it.each([
    ['the key', (key: string) => key],
    ['undefined', () => undefined],
    ['null', () => null],
    ['an empty string', () => ''],
  ])('falls back when the host function returns %s', (_label, t) => {
    const translate = createOfficeTranslator({ locale: 'es', messages: { 'status.IDLE': 'Libre' }, t });
    expect(translate('status.IDLE')).toBe('Libre');
    expect(translate('status.DONE')).toBe('Terminado');
  });
});

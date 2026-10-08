import { describe, expect, it } from 'vitest';
import { APP_MESSAGES, t, type TranslationKey } from '../../src/i18n';
import { OFFICE_MESSAGES } from '../../src/content/officeMessages';
import { AGENT_PANELS_MESSAGES } from '../../src/content/app/agentPanels';
import { MODEL_OPS_MESSAGES } from '../../src/content/app/modelOps';
import { SHELL_MESSAGES } from '../../src/content/app/shell';
import { VIEWS_MESSAGES } from '../../src/content/app/views';
import { DEMO_SCRIPT, localizeDemoText } from '../../src/content/demoScript';
import { LIVING_OFFICE_MESSAGES, livingOfficeText } from '../../src/content/livingOfficeMessages';
import { createDemoSteps, createInitialSimulationState } from '../../src/engine/simulationEngine';
import { INITIAL_AGENTS } from '../../src/engine/officeModel';

type Catalog = Record<string, string>;
interface Pair {
  en: Catalog;
  es: Catalog;
}

const CATALOGS: Record<string, Pair> = {
  app: APP_MESSAGES,
  office: OFFICE_MESSAGES,
  agentPanels: AGENT_PANELS_MESSAGES,
  modelOps: MODEL_OPS_MESSAGES,
  shell: SHELL_MESSAGES,
  views: VIEWS_MESSAGES,
  demoScript: DEMO_SCRIPT,
  livingOffice: LIVING_OFFICE_MESSAGES,
};

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe.each(Object.entries(CATALOGS))('%s catalog', (_name, catalog) => {
  const enKeys = Object.keys(catalog.en).sort();
  const esKeys = Object.keys(catalog.es).sort();

  it('has exactly the same keys in English and Spanish', () => {
    expect(esKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(0);
  });

  it('has a non-empty text for every key in both languages', () => {
    const empty = enKeys.filter((key) => !catalog.en[key]?.trim() || !catalog.es[key]?.trim());
    expect(empty).toEqual([]);
  });

  it('uses the same placeholders in both languages', () => {
    const mismatched = enKeys.filter((key) => placeholders(catalog.en[key]).join() !== placeholders(catalog.es[key]).join());
    expect(mismatched).toEqual([]);
  });

  it('never uses the em dash character', () => {
    const withEmDash = enKeys.filter((key) => catalog.en[key].includes('\u2014') || catalog.es[key].includes('\u2014'));
    expect(withEmDash).toEqual([]);
  });
});

describe('app catalog composition', () => {
  it('does not let one area silently overwrite the keys of another', () => {
    const areas: Array<[string, Catalog]> = [
      ['office', OFFICE_MESSAGES.en],
      ['agentPanels', AGENT_PANELS_MESSAGES.en],
      ['modelOps', MODEL_OPS_MESSAGES.en],
      ['shell', SHELL_MESSAGES.en],
      ['views', VIEWS_MESSAGES.en],
    ];
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const [area, catalog] of areas) {
      for (const key of Object.keys(catalog)) {
        const previous = owner.get(key);
        if (previous) collisions.push(`${key} (${previous} and ${area})`);
        owner.set(key, area);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('includes every area in both languages of the app catalog', () => {
    for (const pair of [OFFICE_MESSAGES, AGENT_PANELS_MESSAGES, MODEL_OPS_MESSAGES, SHELL_MESSAGES, VIEWS_MESSAGES]) {
      for (const key of Object.keys(pair.en)) {
        expect(APP_MESSAGES.en[key as TranslationKey]).toBe(pair.en[key as keyof typeof pair.en]);
        expect(APP_MESSAGES.es[key as TranslationKey]).toBe(pair.es[key as keyof typeof pair.es]);
      }
    }
  });

  it('fills placeholders when translating', () => {
    expect(t('en', 'sidebar.officeSummary', { count: 10 })).toBe('10 agents · 2.5D view');
    expect(t('es', 'sidebar.officeSummary', { count: 10 })).toBe('10 agentes · Vista 2.5D');
  });
});

describe('demo texts by locale', () => {
  it('writes the whole demo script in the requested language', () => {
    for (const locale of ['en', 'es'] as const) {
      const steps = createDemoSteps(locale);
      expect(steps).toHaveLength(12);
      steps.forEach((step, index) => {
        expect(step.title).toBe(DEMO_SCRIPT[locale][`step.${index}.title` as keyof typeof DEMO_SCRIPT.en]);
      });
    }
  });

  it('gives the demo team role titles in each language, with accents in Spanish', () => {
    const en = createInitialSimulationState(INITIAL_AGENTS, 'en');
    const es = createInitialSimulationState(INITIAL_AGENTS, 'es');
    expect(en.agents.find((agent) => agent.id === 'sales-lead')?.roleTitle).toBe('Sales and Accounts Lead');
    expect(es.agents.find((agent) => agent.id === 'sales-lead')?.roleTitle).toBe('Líder Comercial y Ventas');
    expect(en.events[0].summary).toBe(DEMO_SCRIPT.en['init.event']);
  });

  it('shows stored demo texts in the current language and leaves other texts alone', () => {
    expect(localizeDemoText('Líder Comercial y Ventas', 'en')).toBe('Sales and Accounts Lead');
    expect(localizeDemoText('Sales and Accounts Lead', 'es')).toBe('Líder Comercial y Ventas');
    expect(localizeDemoText('Custom role from an event', 'es')).toBe('Custom role from an event');
  });

  it('writes the living office texts in the language of the locale', () => {
    expect(livingOfficeText('es-CO', 'room.meeting_room')).toBe('Sala de reunión A');
    expect(livingOfficeText('en-US', 'room.meeting_room')).toBe('Meeting Room A');
    expect(livingOfficeText(undefined, 'room.overflow', { number: '01' })).toBe('Secret Room 01');
  });
});

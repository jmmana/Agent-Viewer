import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../src/i18n.ts';

test('secondary views expose English and Spanish translations', () => {
  assert.equal(t('en', 'timeline.allEvents'), 'All Events');
  assert.equal(t('es', 'timeline.allEvents'), 'Todos');
  assert.equal(t('en', 'tasks.create'), 'Create New Task');
  assert.equal(t('es', 'tasks.create'), 'Crear Nueva Tarea');
  assert.equal(t('en', 'newTask.dispatch'), 'Dispatch to Organization');
  assert.equal(t('es', 'newTask.dispatch'), 'Enviar a la Organización');
  assert.equal(t('en', 'settings.save'), 'Save Changes');
  assert.equal(t('es', 'settings.save'), 'Guardar Cambios');
  const openApiTexts = [
    ['security.openApi.label', 'OPEN API', 'API ABIERTA'],
    ['security.openApi.title', 'This server has no API token', 'Este servidor no tiene token de API'],
    [
      'security.openApi.body',
      'Anyone who can reach it can send events, change the token and cost figures shown here, and read every usage record.',
      'Cualquiera que llegue a él puede enviar eventos, cambiar las cifras de tokens y costos que ves aquí y leer todo el consumo.',
    ],
    ['security.openApi.action', 'Set AGENT_VIEWER_API_TOKEN and restart the server.', 'Define AGENT_VIEWER_API_TOKEN y reinicia el servidor.'],
    ['security.openApi.docsLink', 'How to set a token', 'Cómo definir un token'],
  ];
  for (const [key, english, spanish] of openApiTexts) {
    assert.equal(t('en', key), english);
    assert.equal(t('es', key), spanish);
  }
});

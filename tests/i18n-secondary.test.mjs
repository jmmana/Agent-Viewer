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
  assert.equal(t('en', 'security.openApi.label'), 'OPEN API');
  assert.equal(t('es', 'security.openApi.label'), 'API ABIERTA');
  for (const key of [
    'security.openApi.title',
    'security.openApi.body',
    'security.openApi.action',
    'security.openApi.docsLink',
  ]) {
    assert.ok(t('en', key).length > 0);
    assert.ok(t('es', key).length > 0);
  }
});

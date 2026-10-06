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
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const asistencia = fs.readFileSync(path.join(root, 'routes', 'asistencia.js'), 'utf8');

test('Estudiantes ofrece los cuatro formatos especiales y conserva la lista general', () => {
  for (const titulo of ['Asistencia a examen','Entrega de tarea','Recepción de tarea','Entrega de temas de examen','Lista general']) {
    assert.match(html, new RegExp(titulo, 'i'));
  }
});

test('las listas especiales incluyen fecha manual, docente, materia, sección y firma', () => {
  assert.match(html, /<strong>Fecha:<\/strong>/);
  assert.match(html, /Profesor\(a\) aplicador\(a\)/);
  assert.match(html, /Docente responsable/);
  assert.match(html, /Firma del estudiante/);
  assert.match(html, /asignacion\.materia_nombre/);
  assert.match(html, /asignacion\.seccion_nombre/);
});

test('las asignaciones de asistencia exponen sección y materia para formar el documento', () => {
  assert.match(asistencia, /SELECT id, seccion_id, materia_id, lecciones_semana/);
});

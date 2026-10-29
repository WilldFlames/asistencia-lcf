const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'routes', 'admin.js'), 'utf8');
const calificaciones = fs.readFileSync(path.join(root, 'routes', 'calificaciones.js'), 'utf8');
const asistencia = fs.readFileSync(path.join(root, 'routes', 'asistencia.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('Hogar e Industriales crean automáticamente sus dos asignaciones semestrales', () => {
  assert.match(admin, /materiaNombre === 'Educación para el Hogar' \? 'A' : 'B'/);
  assert.match(admin, /subgrupoII = subgrupoI === 'A' \? 'B' : 'A'/);
  assert.match(admin, /'I Período'/);
  assert.match(admin, /'II Período'/);
  assert.match(admin, /configuracion_taller:true/);
});

test('la configuración de talleres no modifica el subgrupo del estudiante', () => {
  const bloque = admin.slice(admin.indexOf('// Hogar e Industriales son talleres'), admin.indexOf('const dup =', admin.indexOf('// Hogar e Industriales son talleres')));
  assert.doesNotMatch(bloque, /UPDATE\s+estudiantes/i);
  assert.doesNotMatch(html, /Corregir Subgrupos A\/B<\/button>/);
});

test('Hogar e Industriales usan como nota final el único período cursado', () => {
  assert.match(calificaciones, /esTallerRotativo/);
  assert.match(calificaciones, /periodoEsperado/);
  assert.match(html, /corresponde al único período cursado; no se promedia/);
});

test('Asistencia, Calificaciones y Promedio filtran el período sin duplicar el taller anterior',()=>{
  assert.match(html,/id="asis-periodo"[\s\S]*I Período[\s\S]*II Período/);
  assert.match(html,/id="calif-periodo"[\s\S]*I Período[\s\S]*II Período/);
  assert.match(html,/id="prom-vista" onchange="iniciarPromedio\(\)"/);
  assert.match(asistencia,/const periodoSolicitado=String\(req\.query\.periodo/);
  assert.match(asistencia,/m\.nombre IN \('Educación para el Hogar','Artes Industriales'\)/);
  assert.match(calificaciones,/m\.nombre IN \('Educación para el Hogar','Artes Industriales'\)/);
  assert.match(calificaciones,/m\.nombre NOT IN \('Educación para el Hogar','Artes Industriales'\)/);
  assert.match(html,/const \[i,ii\]=await Promise\.all/);
  assert.match(html,/unicas\.set\(Number\(a\.asignacion_id\),a\)/);
});

test('Calificaciones conserva acceso a asignaciones antiguas y muestra dónde están las evaluaciones de talleres',()=>{
  assert.match(calificaciones,/COALESCE\(a\.anio,\$6\) = \$6/);
  assert.match(calificaciones,/COALESCE\(a2\.anio,\$6\) = \$6/);
  assert.match(calificaciones,/AS evaluaciones_i/);
  assert.match(calificaciones,/AS evaluaciones_ii/);
  assert.match(html,/Evaluaciones guardadas: I período/);
  assert.match(html,/cambiá el filtro para verla/);
});

test('las evaluaciones creadas con asignaciones manuales anteriores siguen consultables sin mezclarlas',()=>{
  assert.match(calificaciones,/true AS legacy_evaluaciones/);
  assert.match(calificaciones,/Una evaluación heredada acredita el acceso/);
  assert.match(calificaciones,/Este es un registro anterior recuperado/);
  assert.match(html,/Registro anterior recuperado de la configuración manual/);
});

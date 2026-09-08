const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'routes', 'admin.js'), 'utf8');
const calificaciones = fs.readFileSync(path.join(root, 'routes', 'calificaciones.js'), 'utf8');
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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');
const comedor = fs.readFileSync(path.join(raiz, 'routes', 'comedor.js'), 'utf8');

test('el carnet usa rutas institucionales cuando el usuario pertenece al comité de comedor', () => {
  assert.match(html, /function carnetUrlSecciones\(\)/);
  assert.match(html, /window\.esComiteComedor\s*\?\s*"\/api\/comedor\/carnet\/secciones"/);
  assert.match(html, /function carnetUrlEstudiantes\(seccionId\)/);
  assert.match(html, /\/api\/comedor\/carnet\/estudiantes\?seccion_id=/);
  assert.match(html, /function carnetUrlFotos\(ids\)/);
  assert.match(html, /\/api\/comedor\/carnet\/fotos\?ids=/);
});

test('las rutas institucionales del carnet exigen pertenecer al comité de comedor', () => {
  assert.match(comedor, /function requireCarnetComite\(req, res, next\)/);
  assert.match(comedor, /router\.get\("\/carnet\/secciones", requireCarnetComite/);
  assert.match(comedor, /router\.get\("\/carnet\/estudiantes", requireCarnetComite/);
  assert.match(comedor, /router\.get\("\/carnet\/fotos", requireCarnetComite/);
  assert.match(comedor, /if\(u\.rol === "admin"\) return next\(\)/);
  assert.doesNotMatch(
    comedor.slice(comedor.indexOf('function requireCarnetComite'), comedor.indexOf('// ── ESTUDIANTES DEL COMEDOR')),
    /u\.rol\s*===\s*["']cocinera["']/
  );
});

test('el permiso especial no modifica el listado general de estudiantes', () => {
  assert.doesNotMatch(comedor, /router\.get\("\/estudiantes"[^]*esComiteComedor/);
  assert.match(comedor, /Estas rutas son deliberadamente exclusivas del módulo Carnet/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const protocolos = fs.readFileSync(path.join(root, 'routes', 'protocolos.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('Pautas tiene un buscador institucional independiente de las secciones docentes', () => {
  assert.match(protocolos, /router\.get\("\/estudiantes\/buscar", puedeUsarPautas/);
  const bloque = protocolos.slice(protocolos.indexOf('router.get("/estudiantes/buscar"'), protocolos.indexOf('// ── CONFIG', protocolos.indexOf('router.get("/estudiantes/buscar"')));
  assert.match(bloque, /FROM estudiantes e/);
  assert.doesNotMatch(bloque, /seccionesPermitidas|profesor_id|seccion_guia/);
});

test('crear una pauta y agregar personas usan el buscador institucional propio', () => {
  const usos = html.match(/\/api\/protocolos\/estudiantes\/buscar\?q=/g) || [];
  assert.ok(usos.length >= 2, 'deben usarlo tanto el formulario inicial como agregar persona');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('Idioma y Tecnología muestra los cinco conteos solicitados', () => {
  for (const id of [
    'it-ingles', 'it-frances', 'it-ingles-conversacional',
    'it-diseno-publicitario', 'it-matem-amprosa'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Resumen de elecciones/);
  assert.match(html, /Inglés Conversacional/);
  assert.match(html, /Diseño Publicitario/);
  assert.match(html, /Matem\/AMPROSA/);
});

test('los conteos respetan el filtro de sección y se actualizan al guardar', () => {
  assert.match(html, /function itListaVisible\(\)/);
  assert.match(html, /itData\.filter\(e=>e\.seccion_nombre===filtro\)/);
  assert.match(html, /function itStats\(lista=itListaVisible\(\)\)/);
  assert.match(html, /e\.idioma==='Inglés'/);
  assert.match(html, /e\.idioma==='Francés'/);
  assert.match(html, /e\.tecnologia==='Inglés Conversacional'/);
  assert.match(html, /e\.tecnologia==='Diseño Publicitario'/);
  assert.match(html, /e\.tecnologia==='Matem\/AMPROSA'/);
});

test('el resumen conserva los indicadores operativos existentes', () => {
  for (const id of ['it-total', 'it-completos', 'it-pendientes', 'it-boletas'])
    assert.match(html, new RegExp(`id="${id}"`));
});

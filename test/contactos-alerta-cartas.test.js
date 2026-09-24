const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('una alerta reconcilia llamadas por profesor y materia aunque cambie la asignación',()=>{
  const route=read('routes/alertaTemprana.js');
  assert.match(route,/async function sincronizarContactosAlerta/);
  assert.match(route,/rl\.estudiante_id=\$3 AND rl\.profesor_id=\$4/);
  assert.match(route,/rl\.materia_id IS NOT DISTINCT FROM \$5::int/);
  assert.doesNotMatch(route,/rl\.asignacion_id IS NOT DISTINCT FROM/);
  assert.match(route,/NOT EXISTS \(SELECT 1 FROM alerta_temprana_contactos c WHERE c\.llamada_id=rl\.id\)/);
  assert.ok((route.match(/await sincronizarContactosAlerta\(/g)||[]).length>=3);
});

test('las cartas de ausentismo son contactos tanto antes como después de abrir la alerta',()=>{
  const db=read('db.js');
  const alertas=read('routes/alertaTemprana.js');
  const cartas=read('routes/cartas.js');
  assert.match(db,/ADD COLUMN IF NOT EXISTS carta_ausentismo_id/);
  assert.match(db,/uq_at_contacto_alerta_carta/);
  assert.match(alertas,/FROM cartas_ausentismo c[\s\S]*c\.emitida_por=\$4[\s\S]*ca\.materia_id IS NOT DISTINCT FROM \$5::int/);
  assert.match(cartas,/WITH nueva AS \([\s\S]*INSERT INTO cartas_ausentismo[\s\S]*INSERT INTO alerta_temprana_contactos/);
  assert.match(cartas,/at\.profesor_id=n\.emitida_por[\s\S]*at\.materia_id IS NOT DISTINCT FROM na\.materia_id/);
  assert.match(cartas,/'Carta de ausentismo','Persona encargada legal'/);
});

test('cada llamada o carta pertenece a una sola alerta',()=>{
  const db=read('db.js');
  assert.match(db,/uq_at_contacto_llamada[\s\S]*alerta_temprana_contactos\(llamada_id\)/);
  assert.match(db,/uq_at_contacto_carta_ausentismo[\s\S]*alerta_temprana_contactos\(carta_ausentismo_id\)/);
});

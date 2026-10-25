const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const raiz=path.join(__dirname,'..');
const rutas=fs.readFileSync(path.join(raiz,'routes','horarios.js'),'utf8');
const db=fs.readFileSync(path.join(raiz,'db.js'),'utf8');
const html=fs.readFileSync(path.join(raiz,'public','index.html'),'utf8');

test('el borrado anual es exclusivo de administración y exige confirmar el año',()=>{
  assert.match(rutas,/router\.get\("\/borrado\/resumen", requireRol\("admin"\)/);
  assert.match(rutas,/router\.delete\("\/anio\/:anio", requireRol\("admin"\)/);
  assert.match(rutas,/confirmar_anio/);
  assert.match(rutas,/String\(req\.body\?\.confirmar_anio\|\|""\)\.trim\(\)!==String\(anio\)/);
});

test('solo elimina grilla y bloques del año solicitado, dentro de una transacción',()=>{
  assert.match(rutas,/DELETE FROM horarios WHERE anio=\$1 RETURNING id/);
  assert.match(rutas,/DELETE FROM horario_bloques_docente WHERE anio=\$1 RETURNING id/);
  assert.match(rutas,/SELECT pg_advisory_xact_lock\(\$1,\$2\)/);
  assert.match(rutas,/await client\.query\("COMMIT"\)/);
  assert.doesNotMatch(rutas,/router\.delete\("\/anio\/:anio"[\s\S]{0,1800}DELETE FROM asignaciones/);
});

test('el borrado se audita con año, cantidades y usuario',()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS horario_borrados_auditoria/);
  assert.match(db,/borrado_por\s+INTEGER REFERENCES usuarios\(id\)/);
  assert.match(rutas,/INSERT INTO horario_borrados_auditoria/);
  assert.match(rutas,/req\.session\.usuario\.id/);
});

test('la interfaz advierte el alcance y obliga a escribir el año',()=>{
  assert.match(html,/id="hor-btn-borrar-anio"/);
  assert.match(html,/function horBorrarHorarioAnio\(\)/);
  assert.match(html,/ME\.rol==='admin'/);
  assert.match(html,/api\(`\/api\/horarios\/borrado\/resumen\?anio=\$\{anio\}`\)/);
  assert.match(html,/prompt\(`Esta acción no se puede deshacer/);
  assert.match(html,/api\(`\/api\/horarios\/anio\/\$\{anio\}`,'DELETE',\{confirmar_anio:anio\}\)/);
});

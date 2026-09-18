const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('cada paso del debido proceso conserva observación y excluye la portada del consolidado',()=>{
  const db=read('db.js'),r=read('routes/debidosProcesos.js'),ui=read('public/index.html');
  assert.match(db,/ALTER TABLE dp_pasos ADD COLUMN IF NOT EXISTS observacion/);
  assert.match(r,/observacion=\$\$\{completar \? 5 : 4\}/);
  assert.match(ui,/imprimirObservacionesDP/);
  assert.match(ui,/p\.tipo!==['"]acta_apertura['"]/);
});

test('matrícula restringida es individual, auditada y solo Dirección autoriza',()=>{
  const db=read('db.js'),r=read('routes/matricula.js'),ui=read('public/index.html');
  assert.match(db,/CREATE TABLE IF NOT EXISTS bloqueos_matricula/);
  assert.match(db,/autorizado_por/);
  assert.match(r,/MATRÍCULA RESTRINGIDA/);
  assert.match(r,/req\.session\.usuario\.rol!==['"]admin['"]/);
  assert.match(ui,/Matrícula restringida/);
  assert.match(r,/COALESCE\(m\.seccion_id,e\.seccion_id\)/);
});

test('ausencias trasladadas se reúnen por estudiante, mismo docente, materia y año',()=>{
  const cal=read('routes/calificaciones.js'),cartas=read('routes/cartas.js');
  assert.match(cal,/ax\.anio=\$1 AND ax\.profesor_id=\$2 AND ax\.materia_id=\$3/);
  assert.match(cal,/a\.estudiante_id=ANY/);
  assert.match(cartas,/ax\.anio=\$4 AND ax\.profesor_id=\$5 AND ax\.materia_id=\$6/);
});

test('el compromiso 2027 advierte que no habrá cambios de sección',()=>{
  assert.match(read('public/index.html'),/NO HABRÁ CAMBIOS DE SECCIÓN PARA EL CURSO LECTIVO 2027/);
});

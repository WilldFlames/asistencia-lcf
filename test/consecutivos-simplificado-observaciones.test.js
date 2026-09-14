const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('todas las series quedan sin un tope institucional pequeño',()=>{
  const consecutivos=read('routes/consecutivos.js'),premat=read('routes/prematricula.js');
  assert.doesNotMatch(consecutivos,/generate_series|const MAX/);
  assert.match(consecutivos,/SELECT c\.numero\+1 FROM consecutivos c/);
  assert.doesNotMatch(premat,/n<=220|máximo 220/);
  assert.doesNotMatch(premat,/generate_series/);
  assert.match(premat,/SELECT consecutivo_prematricula\+1 FROM prematricula/);
});

test('modo simplificado de asignación exige que el período esté seleccionado',()=>{
  const cal=read('routes/calificaciones.js');
  assert.match(cal,/\$5 = ANY\(COALESCE\(a\.simplificado_periodos,ARRAY\[\]::TEXT\[\]\)\)/);
  assert.match(cal,/\$2 = ANY\(COALESCE\(a\.simplificado_periodos,ARRAY\[\]::TEXT\[\]\)\)/);
});

test('observaciones académicas pertenecen a evaluación y estudiante y no a asistencia',()=>{
  const db=read('db.js'),cal=read('routes/calificaciones.js'),ui=read('public/index.html');
  assert.match(db,/CREATE TABLE IF NOT EXISTS evaluacion_observaciones/);
  assert.match(db,/PRIMARY KEY\(evaluacion_id,estudiante_id\)/);
  assert.match(cal,/observaciones_evaluaciones:observacionesPorEstudiante/);
  assert.match(ui,/Observación del examen/);
  assert.match(ui,/calif-observacion-eval/);
  assert.match(ui,/\{examen:'Examen',tarea:'Tarea',cotidiano:'Cotidiano',proyecto:'Proyecto'\}/);
});

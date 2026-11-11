const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('constancias regular y retiro conservan series independientes y trazabilidad',()=>{
  const db=read('db.js'),ruta=read('routes/gestionEstudiantil.js'),ui=read('public/index.html');
  assert.match(db,/UNIQUE\(tipo,anio,numero\)/);
  assert.match(ruta,/pg_advisory_xact_lock/);
  assert.match(ruta,/tipo==='retiro'\?'RET':'CER'/);
  assert.match(ui,/Informe de constancias emitidas/);
  assert.match(ui,/registroConstancia\.consecutivo/);
});

test('traslado importa una nota por materia sin fabricar evaluaciones',()=>{
  const db=read('db.js'),ruta=read('routes/gestionEstudiantil.js'),cal=read('routes/calificaciones.js'),ui=read('public/gestion-estudiantil.js');
  assert.match(db,/CREATE TABLE IF NOT EXISTS notas_traslado/);
  assert.match(db,/UNIQUE\(estudiante_id,materia_id,anio,periodo\)/);
  assert.match(ruta,/notas_traslado_auditoria/);
  assert.match(cal,/total_calculado_sistema:e\.total/);
  assert.match(cal,/nota_I_traslado/);
  assert.match(ui,/Notas del I período/);
});

test('encargado temporal conserva vigencia, resolución y sustitución permanente',()=>{
  const db=read('db.js'),ruta=read('routes/gestionEstudiantil.js');
  assert.match(db,/CREATE TABLE IF NOT EXISTS encargados_temporales/);
  assert.match(db,/entidad_autoriza TEXT NOT NULL/);
  assert.match(db,/numero_resolucion TEXT NOT NULL/);
  assert.match(ruta,/UPDATE encargados SET es_principal=false/);
  assert.match(ruta,/encargado_permanente_id/);
});

test('EPI asigna un único nivel por integrante y deja seguimiento ligado a la alerta',()=>{
  const db=read('db.js'),ruta=read('routes/epi.js'),alerta=read('routes/alertaTemprana.js');
  assert.match(db,/UNIQUE\(usuario_id\), UNIQUE\(nivel\)/);
  assert.match(db,/alerta_temprana_seguimientos_epi/);
  assert.match(ruta,/s\.nivel=\$2/);
  assert.match(ruta,/seguimiento_epi/);
  assert.match(alerta,/seguimientos_epi:seguimientosEpi\.rows/);
});

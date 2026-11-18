const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('horarios importa Excel de forma transaccional y conserva secciones no incluidas',()=>{
  const r=read('routes/horarios.js'),h=read('public/index.html');
  assert.match(r,/router\.post\('\/importar',requireRol\('admin'\)/);
  assert.match(r,/DELETE FROM horarios WHERE anio=\$1 AND seccion_id=ANY/);
  assert.match(r,/BEGIN[\s\S]*pg_advisory_xact_lock[\s\S]*COMMIT/);
  assert.match(h,/Plantilla Excel/);
  assert.match(h,/Asignaciones válidas/);
  assert.match(h,/horImportarExcel/);
});

test('el editor de horario expone I y II período sin ocultar la primera asignación',()=>{
  const r=read('routes/horarios.js'),h=read('public/index.html');
  const tramo=r.slice(r.indexOf('router.get("/asignaciones/:seccion_id"'),r.indexOf('// ── VACIAR'));
  assert.doesNotMatch(tramo,/NOT\s*\([\s\S]*a2\.periodo/);
  assert.match(h,/const periodo=a\.periodo/);
});

test('matrícula limita repitentes a seis dentro del cupo general de 26',()=>{
  const r=read('routes/matricula.js'),db=read('db.js'),h=read('public/index.html');
  assert.match(r,/const MAX_REPITENTES = 6/);
  assert.match(r,/repitentes_lleno:true/);
  assert.match(r,/max_repitentes: MAX_REPITENTES/);
  assert.match(db,/repitente BOOLEAN NOT NULL DEFAULT false/);
  assert.match(h,/id="mat-repitente"/);
});

test('becas de matrícula alimenta un padrón por curso lectivo',()=>{
  const m=read('routes/matricula.js'),c=read('routes/comedor.js'),db=read('db.js');
  assert.match(db,/CREATE TABLE IF NOT EXISTS becas_comedor_anio/);
  assert.match(m,/INSERT INTO becas_comedor_anio/);
  assert.match(c,/LEFT JOIN becas_comedor_anio/);
  assert.match(c,/anio===activo/);
});

test('EPI queda restringido a integrantes y a alertas desde 2027',()=>{
  const e=read('routes/epi.js');
  assert.match(e,/if\(m\)\{req\.epi=m;return next\(\);\}/);
  assert.match(e,/anio<2027/);
  assert.match(e,/acceso:!!m/);
});

test('configurar año admite un segundo grupo de Inglés Conversacional',()=>{
  const r=read('routes/configAnio.js'),h=read('public/index.html'),m=read('routes/matricula.js');
  assert.match(r,/\["Inglés Conversacional","Diseño Publicitario","Matem\/AMPROSA"\]/);
  assert.match(h,/\['Inglés Conversacional','Inglés Conversacional'\]/);
  assert.match(m,/secTecB==='Inglés Conversacional'/);
});

test('administración puede reabrir paso 2 conservando borradores posteriores',()=>{
  const r=read('routes/expedientesConducta.js');
  assert.match(r,/confirmar_posteriores/);
  assert.match(r,/WHERE expediente_id=\$1 AND paso>=2/);
  assert.match(r,/DELETE FROM expedientes_conducta_aprobaciones/);
});

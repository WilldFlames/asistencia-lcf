const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('convocatoria conserva expediente, materias y auditoría aun después del cierre anual',()=>{
  const db=read('db.js');
  assert.match(db,/CREATE TABLE IF NOT EXISTS convocatoria_expedientes/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS convocatoria_materias/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS convocatoria_eventos/);
  assert.match(db,/asignacion_id\s+INTEGER REFERENCES asignaciones\(id\) ON DELETE SET NULL/);
  assert.match(db,/UNIQUE\(estudiante_id,anio\)/);
});

test('la regla institucional usa ocho, ignora materias sin nota y separa las semestrales',()=>{
  const route=read('routes/convocatoria.js');
  assert.match(route,/const LIMITE = 8/);
  assert.match(route,/const INICIO_REGLAS = 2027/);
  assert.match(route,/nota == null \|\| !Number\.isFinite/);
  assert.match(route,/Educación para el Hogar/);
  assert.match(route,/Artes Industriales/);
  assert.match(route,/Aunque[\s\S]*datos antiguos en ambos períodos[\s\S]*UNA asignatura/);
  assert.match(route,/if\(periodo!==periodoOrigen\) return/);
  assert.match(route,/m\.nombre NOT IN \('Guía','Orientación','Fortalecimiento Matemático'\)/);
  assert.match(route,/materia_nombre:"Conducta"/);
  assert.match(route,/resultado_tes==='aprobado'\?'aprobada'/);
  assert.match(route,/tes_pendiente/);
});

test('2026 es informativo y desde 2027 matrícula obedece la condición final',()=>{
  const route=read('routes/convocatoria.js');
  const matricula=read('routes/matricula.js');
  assert.match(route,/modo_informativo:Number\(anio\)<INICIO_REGLAS/);
  assert.match(matricula,/FROM convocatoria_expedientes WHERE estudiante_id=\$1 AND anio=\$2/);
  assert.match(matricula,/Puede completar la matrícula provisional, pero no elegir sección/);
  assert.match(matricula,/debe repetir \$\{control\.nivel\}°/);
});

test('docente solo ve su materia y administración conserva el control cruzado',()=>{
  const route=read('routes/convocatoria.js');
  assert.match(route,/if\(!esGestion\(u\)\).*cm\.profesor_id/);
  assert.match(route,/Solo el docente responsable o Administración puede registrar este resultado/);
  assert.match(route,/pendientes\.length === 1 && cumple \? "estrategia_pendiente"/);
});

test('la interfaz identifica el modo prueba y no revela materias ajenas al docente',()=>{
  const ui=read('public/index.html');
  assert.match(ui,/id="nav-convocatoria"/);
  assert.match(ui,/modo informativo/);
  assert.match(ui,/convData\.ve_detalle\?/);
  assert.match(ui,/Detalle visible para Administración/);
});

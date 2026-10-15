const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('horario especial pertenece únicamente a administración y auxiliares',()=>{
  const ruta=read('routes/horarioEspecial.js');
  const html=read('public/index.html');
  assert.match(ruta,/requireRol\("admin", "auxiliar"\)/);
  assert.match(html,/if\(esAdmin\|\|esAuxiliar\)[\s\S]*nav-horario-especial/);
  assert.match(ruta,/UNIQUE\(fecha,seccion_id\)|ON CONFLICT\(fecha,seccion_id\)/);
});

test('portería aplica jornada efectiva, tolerancia y alerta de identidad',()=>{
  const ruta=read('routes/porteria.js');
  const db=read('db.js');
  const html=read('public/index.html');
  assert.match(ruta,/async function jornadaHoy/);
  assert.match(ruta,/restarMinutos\(jornada\.horaInicio,20\)/);
  assert.match(ruta,/codigo:"entrada_temprana"/);
  assert.match(ruta,/codigo:"sin_horario"/);
  assert.match(ruta,/codigo:"identificacion_desconocida"/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS porteria_intentos_desconocidos/);
  assert.match(html,/pt-critical-flash/);
});

test('el informe identifica quién registró entrada y salida',()=>{
  const ruta=read('routes/porteria.js');
  const html=read('public/index.html');
  assert.match(ruta,/u\.nombre AS registro_nombre/);
  assert.match(html,/Entrada registrada por:/);
  assert.match(html,/Salida registrada por:/);
});

test('la ausencia docente se refleja en la jornada familiar',()=>{
  const db=read('db.js');
  const padres=read('routes/padres.js');
  const html=read('public/index.html');
  assert.match(db,/CREATE TABLE IF NOT EXISTS docente_ausencias/);
  assert.match(padres,/LEFT JOIN LATERAL[\s\S]*docente_ausencias/);
  assert.match(html,/Docente ausente/);
});

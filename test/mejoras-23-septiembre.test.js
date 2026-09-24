const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('las llamadas previas se enlazan al abrir la alerta', () => {
  const route = read('routes/alertaTemprana.js');
  const ui = read('public/index.html');
  assert.match(route, /UPDATE registro_llamadas[\s\S]*alerta_id IS NULL/);
  assert.match(route, /INSERT INTO alerta_temprana_contactos[\s\S]*FROM vinculadas/);
  assert.match(route, /llamadas_vinculadas:llamadasPrevias\.rowCount/);
  assert.match(ui, /Se incorporaron \$\{d\.llamadas_vinculadas\} llamada\(s\) registradas previamente/);
});

test('quien inició el debido proceso puede administrar ofendidos', () => {
  const route = read('routes/debidosProcesos.js');
  const ui = read('public/index.html');
  assert.ok((route.match(/Number\(dp\.iniciado_por\) === Number\(u\.id\)/g) || []).length >= 2);
  assert.match(ui, /esGuia \|\| Number\(dp\.iniciado_por\)===Number\(ME\.id\)/);
});

test('la carta de ampliación registra entrega y se imprime en una página institucional', () => {
  const db = read('db.js');
  const route = read('routes/cartas.js');
  const ui = read('public/index.html');
  assert.match(db, /CREATE TABLE IF NOT EXISTS notificaciones_ampliacion_asistencia/);
  assert.match(route, /router\.post\("\/convocatoria\/:id\/notificar"/);
  assert.match(route, /ON CONFLICT\(convocatoria_id\) DO UPDATE SET[\s\S]*reimpresiones=/);
  assert.match(route, /RETURNING id,entregada_en,reimpresiones,ultima_reimpresion,anio,materia,seccion/);
  assert.match(ui, /NOTIFICACIÓN FORMAL DE INCUMPLIMIENTO DE REQUISITO PARA PRUEBA DE AMPLIACIÓN/);
  assert.match(ui, /class="pdf-page-block"/);
  assert.match(ui, /notificacion_ampliacion_[\s\S]*\{bloquesPagina:true\}/);
});

test('el expediente retirado se imprime con el formato institucional', () => {
  const ui = read('public/index.html');
  assert.match(ui, /onclick="imprimirArchivoRetirado\(\)"/);
  assert.match(ui, /async function imprimirArchivoRetirado\(\)/);
  assert.match(ui, /imprimirPDFMEP\(actual\.soloAcademico\?'ARCHIVO ACADÉMICO DE ESTUDIANTE RETIRADO':'EXPEDIENTE DE ESTUDIANTE RETIRADO'/);
});

test('las listas principales de personal se ordenan por nombre', () => {
  const admin = read('routes/admin.js');
  const agenda = read('routes/agenda.js');
  const horarios = read('routes/horarios.js');
  const padres = read('routes/padres.js');
  assert.match(admin, /ORDER BY nombre,primer_apellido,segundo_apellido/);
  assert.match(agenda, /ORDER BY u\.nombre,u\.primer_apellido,u\.segundo_apellido/);
  assert.match(horarios, /ORDER BY u\.nombre,u\.primer_apellido,u\.segundo_apellido/);
  assert.match(padres, /\$\{a\.nombre\|\|''\}[\s\S]*localeCompare/);
});

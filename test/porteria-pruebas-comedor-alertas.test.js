const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const porteria=read('routes/porteria.js');
const comedor=read('routes/comedor.js');
const html=read('public/index.html');

test('una entrada anticipada genera alarma pero queda registrada si existe jornada',()=>{
  assert.match(porteria,/hora<ingresoDesde[\s\S]*'entrada','permitido'/);
  assert.match(porteria,/codigo:"entrada_temprana",entrada_registrada:true/);
  assert.match(html,/ENTRADA ANTICIPADA REGISTRADA/);
});

test('sin jornada el intento de entrada permanece denegado',()=>{
  assert.match(porteria,/if\(!jornada\.horaInicio\)[\s\S]*'entrada','denegado'/);
  assert.match(porteria,/La sección no tiene pruebas programadas hoy en el calendario publicado/);
  assert.match(porteria,/codigo:"sin_horario"/);
});

test('el calendario publicado de pruebas sustituye la jornada y calcula cuarenta minutos',()=>{
  assert.match(porteria,/FROM calendarios_pruebas[\s\S]*estado='publicado'/);
  assert.match(porteria,/MIN\(e\.hora_inicio\)::text AS primera/);
  assert.match(porteria,/MAX\(e\.hora_inicio\)::text AS ultima/);
  assert.match(porteria,/sumarMinutos\(ultimaPrueba,40\)/);
  assert.match(porteria,/codigo:"salida_antes_fin_pruebas"/);
  assert.match(porteria,/un permiso[\s\S]*no adelanta la salida/);
});

test('Comedor advierte en amarillo un segundo intento sin duplicar la ración',()=>{
  assert.match(comedor,/const nuevo = ya\.rows\.length === 0/);
  assert.match(comedor,/if\(nuevo\)[\s\S]*INSERT INTO comedor_asistencia/);
  assert.match(comedor,/repetido:!nuevo/);
  assert.match(comedor,/No se agregó una segunda ración/);
  assert.match(html,/r\.repetido \? '#fef9c3'/);
  assert.match(html,/4px solid #eab308/);
});

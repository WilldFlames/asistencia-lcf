const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const leer=f=>fs.readFileSync(path.join(root,f),'utf8');

test('Club y Coordinación tienen almacenamiento anual separado de las secciones',()=>{
  const db=leer('db.js');
  assert.match(db,/CREATE TABLE IF NOT EXISTS horario_bloques_docente/);
  assert.match(db,/tipo IN \('club','coordinacion'\)/);
  assert.match(db,/UNIQUE\(profesor_id,anio,dia,leccion\)/);
  assert.match(db,/REFERENCES usuarios\(id\) ON DELETE CASCADE/);
});

test('secretaría puede consultar, pero solo administración modifica bloques docentes',()=>{
  const ruta=leer('routes/horarios.js');
  const ui=leer('public/index.html');
  assert.match(ruta,/router\.post\("\/bloques", requireRol\("admin"\)/);
  assert.match(ruta,/router\.put\("\/bloques\/:id", requireRol\("admin"\)/);
  assert.match(ruta,/router\.delete\("\/bloques\/:id", requireRol\("admin"\)/);
  assert.match(ruta,/router\.get\("\/docente\/:id", requireRol\("admin","secretaria"\)/);
  assert.match(ui,/document\.getElementById\('hor-bloques-admin'\)\.style\.display=ME\.rol==='admin'/);
});

test('el horario completo combina clases y bloques y calcula sus totales',()=>{
  const ruta=leer('routes/horarios.js');
  assert.match(ruta,/async function horarioCompletoDocente/);
  assert.match(ruta,/new Set\(celdas\.map\(c=>`\$\{c\.dia\}-\$\{c\.leccion\}`\)\)\.size/);
  assert.match(ruta,/total_semanal:lecciones\+club\+coordinacion/);
  assert.match(ruta,/res\.json\(\{anio,\.\.\.\(await horarioCompletoDocente/);
});

test('los bloques no pueden coincidir con una clase y las clases respetan los bloques',()=>{
  const ruta=leer('routes/horarios.js');
  assert.match(ruta,/El docente ya tiene .* con la sección .* en esa lección/);
  assert.match(ruta,/JOIN horario_bloques_docente b ON b\.profesor_id=a\.profesor_id/);
  assert.match(ruta,/ya tiene \$\{x\.tipo==='club'\?'Club':'Coordinación'\}/);
});

test('la administración visual ofrece horarios docentes y únicamente dos tipos',()=>{
  const ui=leer('public/index.html');
  assert.match(ui,/id="hor-btn-docentes"/);
  assert.match(ui,/id="hor-docente"/);
  assert.match(ui,/id="hor-bloque-tipo"/);
  assert.match(ui,/<option value="club">🎨 Club<\/option><option value="coordinacion">🤝 Coordinación<\/option>/);
  assert.match(ui,/function horGuardarBloque/);
  assert.match(ui,/function horEditarBloque/);
  assert.match(ui,/function horEliminarBloque/);
});

test('el docente ve el total de lecciones y la impresión lo conserva',()=>{
  const ui=leer('public/index.html');
  assert.match(ui,/Total de lecciones<\/span>/);
  assert.match(ui,/TOTAL DE LECCIONES: \$\{Number\(horResumenActual\?\.lecciones\)\|\|0\}/);
  assert.match(ui,/horRenderHorarioDocente\(r,'Mi horario personal'\)/);
});

test('el cambio anual limpia solo los bloques del año anterior',()=>{
  const matricula=leer('routes/matricula.js');
  assert.match(matricula,/DELETE FROM horario_bloques_docente WHERE anio = \$1/);
  assert.match(matricula,/bloques_horario_borrados/);
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('la precautoria creada genera y permite reimprimir su boleta institucional',()=>{
  const route=read('routes/medidas.js'),ui=read('public/index.html');
  assert.match(route,/boleta-precautoria/);
  assert.match(route,/x\.es_principal DESC/);
  assert.match(ui,/imprimirBoletaPrecautoria\(creada\.id\)/);
  assert.match(ui,/BOLETA MEDIDA PRECAUTORIA/);
  assert.match(ui,/Laura Cruz Jiménez/);
  assert.match(ui,/Liceo de Calle Fallas/);
  assert.match(ui,/imprimirPDFMEP\('BOLETA MEDIDA PRECAUTORIA'/);
});

test('permite elegir cuál encargado recibe y deja recibido con firma, fecha y hora',()=>{
  const db=read('db.js'),route=read('routes/medidas.js'),ui=read('public/index.html');
  assert.match(db,/medidas_estudiantiles ADD COLUMN IF NOT EXISTS encargado_id/);
  assert.match(route,/x\.id=m\.encargado_id/);
  assert.match(route,/El encargado seleccionado no pertenece al estudiante/);
  assert.match(ui,/cargarEncargadosMedida/);
  assert.match(ui,/Recibido por el encargado legal/);
  assert.match(ui,/Fecha: ____ \/ ____ \/ ______/);
  assert.match(ui,/Hora: ________/);
  assert.match(ui,/text-decoration:underline/);
});

test('la boleta calcula días naturales, fecha de regreso y folio',()=>{
  const ui=read('public/index.html');
  assert.match(ui,/Math\.round\(\(fin-inicio\)\/86400000\)\+1/);
  assert.match(ui,/regreso\.setDate\(regreso\.getDate\(\)\+1\)/);
  assert.match(ui,/String\(d\.id\)\.padStart\(4,'0'\)/);
});

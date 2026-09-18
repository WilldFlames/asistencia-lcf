const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('la precautoria creada genera y permite reimprimir su boleta institucional',()=>{
  const route=read('routes/medidas.js'),ui=read('public/index.html');
  assert.match(route,/boleta-precautoria/);
  assert.match(route,/ORDER BY x\.es_principal DESC/);
  assert.match(ui,/imprimirBoletaPrecautoria\(creada\.id\)/);
  assert.match(ui,/BOLETA MEDIDA PRECAUTORIA/);
  assert.match(ui,/Laura Cruz Jiménez/);
  assert.match(ui,/Liceo de Calle Fallas/);
  assert.match(ui,/imprimirPDFMEP\('BOLETA MEDIDA PRECAUTORIA'/);
});

test('la boleta calcula días naturales, fecha de regreso y folio',()=>{
  const ui=read('public/index.html');
  assert.match(ui,/Math\.round\(\(fin-inicio\)\/86400000\)\+1/);
  assert.match(ui,/regreso\.setDate\(regreso\.getDate\(\)\+1\)/);
  assert.match(ui,/String\(d\.id\)\.padStart\(4,'0'\)/);
});

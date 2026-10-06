const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const raiz=path.join(__dirname,'..');
const leer=archivo=>fs.readFileSync(path.join(raiz,archivo),'utf8');

test('las observaciones de cada paso se guardan, recuperan y consolidan aun con datos anteriores',()=>{
  const db=leer('db.js'),route=leer('routes/debidosProcesos.js'),ui=leer('public/index.html');
  assert.match(db,/ALTER TABLE dp_pasos ADD COLUMN IF NOT EXISTS observacion TEXT/);
  assert.match(route,/const observacionLimpia=String\(observacion\|\|""\)\.trim\(\)/);
  assert.match(route,/_observacion_paso:observacionLimpia/);
  assert.match(route,/observacion=\$\$\{completar \? 5 : 4\}/);
  assert.match(route,/observacion_efectiva/);
  assert.match(ui,/observacion_efectiva \?\? reg\?\.observacion \?\? reg\?\.contenido\?\._observacion_paso/);
  assert.match(ui,/observacion:p\.observacion_efectiva\?\?p\.observacion\?\?p\.contenido\?\._observacion_paso/);
});

test('el buscador de Portería es informativo y muestra entradas y salidas del día',()=>{
  const route=leer('routes/porteria.js'),ui=leer('public/index.html');
  assert.match(route,/router\.get\("\/estudiante\/:id\/movimientos", canEscanear/);
  assert.match(route,/WHERE r\.estudiante_id=\$1 AND r\.fecha=\$2/);
  assert.match(ui,/onclick="ptConsultarMovimientos\(this\.dataset\.id\)"/);
  assert.match(ui,/id="pt-consulta-estudiante"/);
  assert.match(ui,/No tiene entradas ni salidas registradas en esta fecha/);
  assert.doesNotMatch(ui,/function ptSeleccionarBusqueda\(cedula\)/);
});

test('Biblioteca permite retirar un artículo sin borrar préstamos históricos',()=>{
  const db=leer('db.js'),route=leer('routes/biblioteca.js'),ui=leer('public/index.html');
  assert.match(db,/biblioteca_items ADD COLUMN IF NOT EXISTS desactivado_por/);
  assert.match(route,/router\.delete\('\/items\/:id'/);
  assert.match(route,/No se puede eliminar mientras tenga préstamos pendientes/);
  assert.match(route,/UPDATE biblioteca_items SET activo=false/);
  assert.doesNotMatch(route,/DELETE FROM biblioteca_items/);
  assert.match(ui,/function bibEliminarItem\(id\)/);
  assert.match(ui,/Los préstamos anteriores se conservarán/);
});

test('cada declaración puede sustituir solamente a Orientación en ese documento',()=>{
  const db=leer('db.js'),route=leer('routes/debidosProcesos.js'),ui=leer('public/index.html');
  assert.match(db,/dp_pasos ADD COLUMN IF NOT EXISTS orientador_sustituto_id/);
  assert.match(route,/router\.get\("\/personal\/declaraciones"/);
  assert.match(route,/Sin permisos para consultar el personal de declaraciones/);
  assert.match(route,/\["decl_ofendido","decl_ofensor","decl_testigo"\]\.includes\(tipo\)/);
  assert.match(route,/orientador_sustituto_id=\$\$\{completar \? 6 : 5\}/);
  assert.match(ui,/id="dpp-orientador_sustituto_id"/);
  assert.match(ui,/Solo cambia esta declaración y su espacio de firma; no modifica el resto del proceso/);
  assert.match(ui,/persona sustituta de Orientación/);
  assert.match(ui,/orientadorDeclaracion/);
});

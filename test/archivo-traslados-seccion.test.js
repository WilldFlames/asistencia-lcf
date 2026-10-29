const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const raiz=path.join(__dirname,'..');
const leer=p=>fs.readFileSync(path.join(raiz,p),'utf8');
const db=leer('db.js');
const estudiantes=leer('routes/estudiantes.js');
const expediente=leer('routes/expediente.js');
const ui=leer('public/index.html');

test('el archivo separa retirados de traslados de sección',()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS expediente_traslados/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS expediente_traslado_academico/);
  assert.match(ui,/archivo-tab-retirados/);
  assert.match(ui,/archivo-tab-traslados/);
  assert.match(ui,/function archivoCambiarTipo/);
});

test('un traslado archiva únicamente materias cuyo docente cambia',()=>{
  assert.match(estudiantes,/async function prepararArchivoTraslado/);
  assert.match(estudiantes,/Number\(aDestino\.profesor_id\)===Number\(aOrigen\.profesor_id\)/);
  assert.match(estudiantes,/if\(aDestino&&Number\(aDestino\.profesor_id\)===Number\(aOrigen\.profesor_id\)\) continue/);
  assert.match(estudiantes,/calcularPromedioEstudianteArchivado/);
  assert.match(estudiantes,/nota_cotidiano:rb\.cotidiano\?\.nota_100/);
  assert.match(estudiantes,/guardarArchivoTraslado/);
});

test('el cambio de sección y su archivo se confirman juntos',()=>{
  const inicio=estudiantes.indexOf('const client=await pool.connect()',estudiantes.indexOf('router.put("/:id/seccion"'));
  const insercion=estudiantes.indexOf('guardarArchivoTraslado(client',inicio);
  const cambio=estudiantes.indexOf('UPDATE estudiantes SET seccion_id=$1',inicio);
  const commit=estudiantes.indexOf("await client.query('COMMIT')",inicio);
  assert.ok(inicio>0&&insercion>inicio&&cambio>insercion&&commit>cambio);
  assert.match(estudiantes,/await client\.query\('ROLLBACK'\)/);
});

test('el detalle conserva porcentajes por rubro y docentes anterior y nuevo',()=>{
  assert.match(expediente,/router\.get\("\/traslados"/);
  assert.match(expediente,/router\.get\("\/traslados\/:trasladoId"/);
  assert.match(expediente,/profesor_origen_id=\$3 OR permiso\.profesor_destino_id=\$3/);
  assert.match(ui,/Docente anterior/);
  assert.match(ui,/Docente nuevo/);
  assert.match(ui,/Los porcentajes corresponden al aporte alcanzado en cada rubro/);
  assert.match(ui,/ARCHIVO ACADÉMICO POR TRASLADO DE SECCIÓN/);
});

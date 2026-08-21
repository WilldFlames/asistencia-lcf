const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const db=read('db.js');
const server=read('server.js');
const routes=read('routes/extramuros.js');
const html=read('public/index.html');
const ui=read('public/extramuros.js');

test('Extramuros conserva actividad, responsables y un consecutivo anual por estudiante',()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS extramuros\s*\(/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS extramuros_responsables\s*\(/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS extramuros_estudiantes\s*\(/);
  assert.match(db,/UNIQUE\s*\(anio,\s*consecutivo\)/);
  assert.match(routes,/pg_advisory_xact_lock/);
  assert.match(routes,/BEGIN/);
  assert.match(routes,/COMMIT/);
  assert.match(routes,/ROLLBACK/);
  assert.match(routes,/ORDER BY xe\.consecutivo/);
});

test('la edición conserva consecutivos y la anulación es una baja histórica',()=>{
  assert.match(routes,/UPDATE extramuros_estudiantes SET activo=false/);
  assert.match(routes,/UPDATE extramuros_estudiantes SET activo=true,orden=/);
  assert.match(routes,/const nuevos=d\.estudiantes\.filter/);
  assert.match(routes,/estado='anulado'/);
  assert.match(routes,/motivo_anulacion/);
  assert.doesNotMatch(routes,/DELETE FROM extramuros_estudiantes/);
});

test('el módulo selecciona responsables y estudiantes por sección en tres pasos',()=>{
  assert.match(server,/app\.use\("\/api\/extramuros"/);
  assert.match(html,/id="nav-extramuros"/);
  assert.match(html,/id="page-extramuros"/);
  assert.match(html,/data-ext-step="1"/);
  assert.match(html,/data-ext-step="2"/);
  assert.match(html,/data-ext-step="3"/);
  assert.match(ui,/function extAgregarResponsable/);
  assert.match(ui,/function extPoblarEstudiantes/);
  assert.match(ui,/Number\(e\.seccion_id\)===seccion/);
  assert.match(ui,/function extAgregarEstudiante/);
});

test('el formulario nuevo permanece oculto como modal y no se mezcla con Asistencia',()=>{
  assert.match(html,/<div class="modal-overlay" id="modal-extramuros" aria-hidden="true">/);
  assert.match(html,/<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ext-modal-title"/);
  assert.doesNotMatch(html,/<div class="modal" id="modal-extramuros">/);
  assert.match(html,/modalExtramuros&&page!=="extramuros"/);
  assert.match(html,/modalExtramuros\.classList\.remove\("show"\)/);
  assert.match(html,/#modal-extramuros:not\(\.show\)\{display:none!important;\}/);
  assert.match(html,/#modal-extramuros\.show\{display:flex!important;\}/);
  assert.match(ui,/modal\.setAttribute\("aria-hidden","false"\)/);
});

test('cada estudiante produce tres anexos dentro de un único PDF con encabezado y pie MEP',()=>{
  assert.match(ui,/function extPaginaAnexo1/);
  assert.match(ui,/function extPaginaAnexo2/);
  assert.match(ui,/function extPaginaAnexo3/);
  assert.match(ui,/d\.estudiantes\.forEach\(e=>paginas\.push\(extPaginaAnexo1\(d,e\),extPaginaAnexo2\(d,e\),extPaginaAnexo3\(d,e\)\)\)/);
  assert.match(ui,/await imprimirPaginasPDFMEP\(paginas/);
  assert.match(ui,/Dirección Regional<br>Desamparados/);
  assert.match(ui,/Supervisión Educativa<br>Circuito 07/);
  assert.match(ui,/lic\.callefallas@mep\.go\.cr/);
  assert.match(ui,/Página \$\{i\+1\} de \$\{paginasHTML\.length\}/);
  assert.match(ui,/EXT-\$\{String\(n\)\.padStart\(3,"0"\)\}-\$\{anio\}/);
});

test('los anexos autorrellenan estudiante, sección, encargado, salud y dirección',()=>{
  for(const campo of ['encargado_nombre','encargado_cedula','encargado_parentesco','enfermedad','medicamento','telefonos_emergencia']){
    assert.match(routes,new RegExp(campo));
    assert.match(ui,new RegExp(campo));
  }
  assert.match(routes,/SELECT \* FROM config_centro/);
  assert.match(ui,/director_nombre/);
  assert.match(ui,/extNombrePersona\(e\)/);
  assert.match(ui,/e\.seccion_nombre/);
  assert.doesNotMatch(ui,/background\s*:\s*yellow/i);
});

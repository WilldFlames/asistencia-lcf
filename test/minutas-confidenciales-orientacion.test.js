const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const leer=f=>fs.readFileSync(path.join(root,f),'utf8');
const db=leer('db.js');
const ruta=leer('routes/minutas.js');
const ui=leer('public/index.html');

test('las minutas pueden convertirse en documentos confidenciales vinculados a estudiantes',()=>{
  assert.match(db,/minutas ADD COLUMN IF NOT EXISTS es_confidencial BOOLEAN NOT NULL DEFAULT false/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS minuta_estudiantes/);
  assert.match(db,/UNIQUE\(minuta_id, estudiante_id\)/);
  assert.match(ruta,/INSERT INTO minuta_estudiantes\(minuta_id,estudiante_id,vinculado_por\)/);
});

test('el acceso confidencial sigue la sección actual y la asignación anual de Orientación',()=>{
  assert.match(ruta,/JOIN estudiantes e_acc ON e_acc\.id=me_acc\.estudiante_id/);
  assert.match(ruta,/seccion_orientador_anio soa_acc/);
  assert.match(ruta,/soa_acc\.anio=\$\$\{anioParam\}/);
  assert.match(ruta,/soa_acc\.orientador_id=\$\$\{usuarioParam\}/);
  assert.match(ruta,/NOT EXISTS \([\s\S]*seccion_orientador_anio soa_any/);
  assert.match(ruta,/puedeAccederConfidencial/);
});

test('los documentos confidenciales no heredan acceso de asistentes o supervisión',()=>{
  assert.match(ruta,/m\.es_confidencial=false AND \$\{filtroVisibilidadSQL/);
  assert.match(ruta,/where\.push\("m\.es_confidencial=false"\)/);
  assert.match(ruta,/Los documentos confidenciales no pueden ser reabiertos por supervisión/);
  assert.match(ruta,/únicamente puede verlo la persona orientadora responsable del nivel actual/);
});

test('Orientación selecciona estudiantes del sistema y reconoce el documento en pantalla e impresión',()=>{
  assert.match(ui,/id="nmin-confidencial"/);
  assert.match(ui,/id="nmin-estudiantes" multiple/);
  assert.match(ui,/\/api\/minutas\/confidenciales\/estudiantes/);
  assert.match(ui,/Documento confidencial de Orientación/);
  assert.match(ui,/DOCUMENTO CONFIDENCIAL DE ORIENTACIÓN/);
  assert.match(ui,/Sección actual/);
});


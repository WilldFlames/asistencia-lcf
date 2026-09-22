const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const rutas=fs.readFileSync(path.join(root,'routes','reportes.js'),'utf8');
const front=fs.readFileSync(path.join(root,'public','index.html'),'utf8');

test('Conducta e Informes conservan si el alcance es A B o grupo completo',()=>{
  assert.match(rutas,/router\.get\("\/mis-grupos"/);
  assert.match(rutas,/NULLIF\(UPPER\(TRIM\(a\.subgrupo\)\),''\) AS subgrupo/);
  assert.match(rutas,/Sección guía completa/);
  assert.match(rutas,/Seleccione el grupo A o B que tiene asignado/);
  assert.match(front,/api\/reportes\/mis-grupos/);
  assert.match(front,/subgrupo=\$\{encodeURIComponent\(grupo\.subgrupo\)\}/);
});

test('la impresión de conducta usa el mismo subgrupo elegido en pantalla',()=>{
  assert.match(front,/let condSubgrupoActual = null/);
  assert.match(front,/condGrupoLabelActual/);
  assert.match(front,/api\/reportes\/seccion\/\$\{secId\}\/estudiantes\$\{qs\}/);
  assert.match(front,/const nombreSec = condGrupoLabelActual/);
});

test('el reporte distingue claramente guía de profesor de materia',()=>{
  assert.match(rutas,/router\.get\("\/mis-alcances-reporte"/);
  assert.match(rutas,/Profesor guía —/);
  assert.match(rutas,/Profesor de \$\{x\.materia_nombre\} —/);
  assert.match(rutas,/AND asig\.id = \$\$\{params\.length\}/);
  assert.match(front,/Solicitar reporte como/);
  assert.match(front,/Reporte solicitado como:/);
  assert.match(front,/asignacion_id=\$\{alcance\.asignacion_id\}/);
});

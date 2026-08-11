const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz=path.join(__dirname,'..');
const leer=p=>fs.readFileSync(path.join(raiz,p),'utf8');
const db=leer('db.js');
const cartas=leer('routes/cartas.js');
const admin=leer('routes/admin.js');
const config=leer('routes/configAnio.js');
const matricula=leer('routes/matricula.js');
const frontend=leer('public/index.html');

test('la carta calcula desde el inicio oficial del curso hasta hoy',()=>{
  assert.match(cartas,/async function rangoCursoHastaHoy/);
  assert.match(cartas,/cal\.periodo_i_inicio/);
  assert.match(cartas,/sa\.fecha BETWEEN \$3 AND \$4/);
  assert.match(cartas,/ast\.estado='A' AND NOT ast\.justificada/);
  assert.match(frontend,/desde el inicio oficial del curso lectivo hasta hoy/);
  assert.doesNotMatch(frontend,/durante el <strong>\$\{periodoLbl\}/);
});

test('la exclusión de convocatoria pertenece a profesor, asignatura y estudiante',()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS convocatoria_ausentismo/);
  assert.match(db,/UNIQUE\(anio, estudiante_id, asignacion_id, profesor_id\)/);
  assert.match(cartas,/router\.post\("\/convocatoria\/marcar"/);
  assert.match(cartas,/calculo\.porcentaje<=20/);
  assert.match(cartas,/AND ca\.profesor_id=\$2/);
  assert.match(frontend,/Sin derecho a convocatoria por ausentismo/);
  assert.match(frontend,/ACTA DE ESTUDIANTES SIN DERECHO A CONVOCATORIA POR AUSENTISMO/);
});

test('restricciones usa la lista institucional completa',()=>{
  assert.match(matricula,/router\.get\("\/restricciones-estudiantes\/:anio"/);
  assert.match(matricula,/FROM estudiantes e/);
  assert.match(frontend,/rmEstudiantes=await api\(`\/api\/matricula\/restricciones-estudiantes/);
  assert.match(frontend,/const lista = \(rmEstudiantes\|\|\[\]\)/);
});

test('las secciones inactivas no reaparecen en asignaciones ni tras desplegar',()=>{
  assert.match(admin,/JOIN secciones_anio san ON san\.seccion_id=a\.seccion_id AND san\.anio=\$2 AND san\.activa=true/);
  assert.match(config,/DO UPDATE SET activa=false/);
  assert.match(db,/WHERE NOT EXISTS \(SELECT 1 FROM secciones_anio existente WHERE existente\.anio=a\.anio\)/);
});

test('el generador PDF pagina el contenido sin invadir encabezado ni pie',()=>{
  assert.match(frontend,/const contentCanvas = await html2canvas\(wrap/);
  assert.match(frontend,/function buscarCorteSeguro\(desde, limite\)/);
  assert.match(frontend,/const contenidoY = Math\.max\(28, headerY \+ headerScaled \+ 3\)/);
  assert.match(frontend,/const contenidoFinY = footerY - 3/);
  assert.match(frontend,/pdf\.addImage\(headerData,'JPEG'/);
  assert.match(frontend,/pdf\.addImage\(footerData,'JPEG'/);
  assert.match(frontend,/Página \$\{indice\+1\} de \$\{cortes\.length\}/);
  assert.doesNotMatch(frontend,/html2pdf\(\)\.set\(opt\)\.from\(wrap\)/);
});

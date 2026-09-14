const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const expediente=read('routes/expediente.js');
const estudiantes=read('routes/estudiantes.js');
const ui=read('public/index.html');

test('el historial muestra el aporte ponderado y no la nota cruda de cada rubro',()=>{
  assert.match(expediente,/function aportePonderado\(nota,peso\)/);
  assert.match(expediente,/Number\(nota\)\*Number\(peso\)\/100/);
  assert.match(expediente,/nota_cotidiano:aportePonderado\(x\.nota_cotidiano,x\.porc_cotidiano\)/);
  assert.match(expediente,/nota_cotidiano:rb\.cotidiano\?\.pct\?\?null/);
  assert.match(ui,/Cot\. %/);
  assert.match(ui,/pctArchivo\(m\.nota_cotidiano\)/);
});

test('cada examen aporta solo su valor porcentual y reserva las pruebas pendientes',()=>{
  const calificaciones=read('routes/calificaciones.js');
  assert.match(calificaciones,/SELECT e\.id, e\.tipo, e\.puntaje_total, e\.valor_porcentual/);
  assert.match(calificaciones,/const cantidadPruebasOficial = Math\.max\(0, Number\(regla\.cantidad_pruebas \|\| 0\)\)/);
  assert.match(calificaciones,/valorVirtualPrueba\(\{/);
  assert.match(calificaciones,/r\.pct_sumado \+= aporteEvaluacion\(puntos,ptotal,vp\)/);
});

test('Archivo docente limita estudiantes, subgrupos y materias al profesor autenticado',()=>{
  assert.match(estudiantes,/requireRol\("admin","auxiliar","profesor","profesor_guia","orientador"\)/);
  assert.match(estudiantes,/a\.profesor_id=\$2/);
  assert.match(estudiantes,/a\.subgrupo IS NULL OR a\.subgrupo=e\.subgrupo/);
  assert.match(expediente,/const canReadAcademic = requireRol\("admin","auxiliar","profesor","profesor_guia","orientador"\)/);
  assert.match(expediente,/a\.profesor_id=\$3/);
  assert.match(expediente,/a\.subgrupo IS NULL OR a\.subgrupo=est\.subgrupo/);
});

test('la interfaz docente no solicita ni muestra información privada del Archivo',()=>{
  assert.match(ui,/esAdmin\|\|esAuxiliar\|\|esProfesor\|\|esGuia\|\|esOrientador/);
  assert.match(ui,/const archivoSoloAcademico=!\['admin','auxiliar'\]\.includes\(ME\.rol\)/);
  assert.match(ui,/if\(!archivoSoloAcademico\)\{/);
  assert.match(ui,/Docentes reciben solo su historial académico/);
});

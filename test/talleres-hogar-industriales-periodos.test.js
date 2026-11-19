const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'routes', 'admin.js'), 'utf8');
const calificaciones = fs.readFileSync(path.join(root, 'routes', 'calificaciones.js'), 'utf8');
const asistencia = fs.readFileSync(path.join(root, 'routes', 'asistencia.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('Hogar e Industriales crean automáticamente sus dos asignaciones semestrales desde 2027', () => {
  assert.match(admin, /anioFinal >= 2027/);
  assert.match(admin, /materiaNombre === 'Educación para el Hogar' \? 'A' : 'B'/);
  assert.match(admin, /subgrupoII = subgrupoI === 'A' \? 'B' : 'A'/);
  assert.match(admin, /'I Período'/);
  assert.match(admin, /'II Período'/);
  assert.match(admin, /configuracion_taller:true/);
});

test('la lista administrativa identifica el período solo en Hogar e Industriales', () => {
  assert.match(html, /const esTallerSemestral = Number\(a\.anio\)>=2027/);
  assert.match(html, /\['Educación para el Hogar','Artes Industriales'\]\.includes\(a\.materia_nombre\)/);
  assert.match(html, /distintivoPeriodoTaller/);
  assert.match(html, /htmlSeguro\(a\.periodo\|\|'I Período'\)/);
  assert.match(html, /\$\{distintivoPeriodoTaller\}<\/td>/);
});

test('el editor de horario muestra el período solo en Hogar e Industriales', () => {
  assert.match(html, /const esTallerRotativo=\['Educación para el Hogar','Artes Industriales'\]\.includes\(a\.materia_nombre\)/);
  assert.match(html, /const periodo=esTallerRotativo && a\.periodo \? ` · \$\{a\.periodo\}` : ''/);
});

test('la configuración de talleres no modifica el subgrupo del estudiante', () => {
  const bloque = admin.slice(admin.indexOf('// Hogar e Industriales son talleres'), admin.indexOf('const dup =', admin.indexOf('// Hogar e Industriales son talleres')));
  assert.doesNotMatch(bloque, /UPDATE\s+estudiantes/i);
  assert.doesNotMatch(html, /Corregir Subgrupos A\/B<\/button>/);
});

test('Hogar e Industriales usan como nota final el único período cursado', () => {
  assert.match(calificaciones, /esTallerRotativo/);
  assert.match(calificaciones, /periodoEsperado/);
  assert.match(html, /corresponde al único período cursado; no se promedia/);
});

test('Asistencia, Calificaciones y Promedio filtran el período sin duplicar el taller anterior',()=>{
  assert.match(html,/id="asis-periodo"[\s\S]*I Período[\s\S]*II Período/);
  assert.match(html,/id="calif-periodo"[\s\S]*I Período[\s\S]*II Período/);
  assert.match(html,/id="prom-vista" onchange="iniciarPromedio\(\)"/);
  assert.match(asistencia,/const periodoSolicitado=String\(req\.query\.periodo/);
  assert.match(asistencia,/m\.nombre IN \('Educación para el Hogar','Artes Industriales'\)/);
  assert.match(calificaciones,/m\.nombre IN \('Educación para el Hogar','Artes Industriales'\)/);
  assert.match(calificaciones,/m\.nombre NOT IN \('Educación para el Hogar','Artes Industriales'\)/);
  assert.match(html,/const \[i,ii\]=await Promise\.all/);
  assert.match(html,/unicas\.set\(Number\(a\.asignacion_id\),a\)/);
});

test('Calificaciones conserva acceso a asignaciones antiguas y muestra dónde están las evaluaciones de talleres',()=>{
  assert.match(calificaciones,/COALESCE\(a\.anio,\$6\) = \$6/);
  assert.match(calificaciones,/COALESCE\(a2\.anio,\$6\) = \$6/);
  assert.match(calificaciones,/AS evaluaciones_i/);
  assert.match(calificaciones,/AS evaluaciones_ii/);
  assert.match(html,/Evaluaciones guardadas: I período/);
  assert.match(html,/cambiá el filtro para verla/);
});

test('las evaluaciones creadas con asignaciones manuales anteriores siguen consultables sin mezclarlas',()=>{
  assert.match(calificaciones,/true AS legacy_evaluaciones/);
  assert.match(calificaciones,/Una evaluación heredada acredita el acceso/);
  assert.doesNotMatch(calificaciones,/Este es un registro anterior recuperado\. Podés consultar y completar/);
  assert.match(calificaciones,/\$6 < 2027 OR m\.nombre NOT IN/);
  assert.match(calificaciones,/\(COUNT\(\*\) FILTER \(WHERE ev\.periodo='I Período'\)\)::int AS evaluaciones_i/);
  assert.doesNotMatch(calificaciones,/COUNT\(\*\)::int FILTER/);
  assert.match(html,/Asignación manual 2026 recuperada — podés continuar editándola/);
});

test('familias y carta de matrícula agrupan Hogar e Industriales sin exponer A/B ni períodos',()=>{
  assert.match(html,/function horarioFamiliarAgruparTalleres\(celdas=\[\]\)/);
  assert.match(html,/materia_nombre:'Hogar \/ Industriales'/);
  assert.match(html,/Hogar: \$\{hogar\} · Industriales: \$\{industriales\}/);
  assert.match(html,/const celdasFamilia=horarioFamiliarAgruparTalleres\(r\.celdas\|\|\[\]\)/);
  assert.match(html,/const celdas=horarioFamiliarAgruparTalleres\(r\.celdas\|\|\[\]\)/);
  assert.match(html,/c\.es_taller_familiar\?'':`Aula `/);
});

test('el agrupador familiar produce una sola tarjeta con las dos aulas',()=>{
  const inicio=html.indexOf('function horarioFamiliarAgruparTalleres');
  const fin=html.indexOf('// Generar los documentos',inicio);
  const contexto={horAulaEtiqueta:v=>/^\d+$/.test(String(v||''))?`Aula ${Number(v)}`:String(v||'').trim()};
  vm.runInNewContext(`${html.slice(inicio,fin)};resultado=horarioFamiliarAgruparTalleres([
    {dia:3,leccion:1,materia_nombre:'Artes Industriales',subgrupo:'B',periodo:'I Período',aula:'Aula 2'},
    {dia:3,leccion:1,materia_nombre:'Educación para el Hogar',subgrupo:'A',periodo:'I Período',aula:'Biblioteca'},
    {dia:3,leccion:1,materia_nombre:'Artes Industriales',subgrupo:'A',periodo:'II Período',aula:'Aula 2'},
    {dia:3,leccion:1,materia_nombre:'Educación para el Hogar',subgrupo:'B',periodo:'II Período',aula:'Biblioteca'},
    {dia:3,leccion:2,materia_nombre:'Matemática',aula:'21'}
  ]);`,contexto);
  assert.equal(contexto.resultado.length,2);
  assert.equal(contexto.resultado[0].materia_nombre,'Hogar / Industriales');
  assert.equal(contexto.resultado[0].aula,'Hogar: Biblioteca · Industriales: Aula 2');
  assert.equal(contexto.resultado[1].materia_nombre,'Matemática');
});

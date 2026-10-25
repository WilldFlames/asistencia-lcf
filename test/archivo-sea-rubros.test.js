const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const front=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const inicio=front.indexOf('function prom_descargarSEA()');
const fin=front.indexOf('\nfunction prom_imprimirActa()',inicio);
const sea=front.slice(inicio,fin);

test('el CSV SEA decide Prueba y Proyecto a partir de la regla REAC',()=>{
  assert.match(sea,/Number\(regla\.porc_pruebas\) > 0/);
  assert.match(sea,/encabezado:'Prueba', rubro:'examen'/);
  assert.match(sea,/Number\(regla\.porc_proyectos\) > 0/);
  assert.match(sea,/encabezado:'Proyecto', rubro:'proyecto'/);
  assert.doesNotMatch(sea,/const encabezado = '\"Id\";\"Nombre\";\"Trabajo cotidiano\";\"Tareas\";\"Prueba\"/);
});

test('cada columna SEA toma el aporte del rubro que identifica su encabezado',()=>{
  assert.match(sea,/e\.rubros\?\.\[c\.rubro\]\?\.pct/);
  assert.match(sea,/\.map\(v=>`\"\$\{String\(v\)\.replace/);
  assert.match(sea,/\.join\(';\'\)/);
});

test('si una materia tiene prueba y proyecto conserva ambas columnas',()=>{
  const prueba=sea.indexOf("columnasEvaluacion.push({ encabezado:'Prueba'");
  const proyecto=sea.indexOf("columnasEvaluacion.push({ encabezado:'Proyecto'");
  assert.ok(prueba>=0 && proyecto>prueba);
  assert.match(sea,/\.\.\.columnasEvaluacion\.map\(c=>c\.encabezado\)/);
  assert.match(sea,/\.\.\.evaluacion,asist/);
});

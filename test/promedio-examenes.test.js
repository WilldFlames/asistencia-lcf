const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {aporteEvaluacion,valorVirtualPrueba}=require('../utils/calculo-calificaciones');

test('una sola prueba usa su 25% individual y no el 50% completo del rubro',()=>{
  const vp=valorVirtualPrueba({pesoRubro:50,cantidadPruebas:2,valoresExistentes:[null]});
  assert.equal(vp,25);
  assert.ok(Math.abs(aporteEvaluacion(66.7,100,vp)-16.675)<1e-10);
});

test('una prueba con valor guardado aporta exactamente ese valor',()=>{
  assert.equal(aporteEvaluacion(20,20,25),25);
  assert.equal(aporteEvaluacion(10,20,25),12.5);
});

test('Promedio y sus impresiones muestran el aporte calculado por el servidor',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  assert.match(ui,/const pct = r && r\.pct != null \? Number\(r\.pct\)\.toFixed\(1\)/);
  assert.match(ui,/const v = r && r\.pct != null \? Number\(r\.pct\)\.toFixed\(1\)/);
  assert.match(ui,/e\.rubros\[r\.key\]\.pct != null \? Number\(e\.rubros\[r\.key\]\.pct\)\.toFixed\(1\)/);
});

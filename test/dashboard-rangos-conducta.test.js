const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('el tablero clasifica conducta según el mínimo y nivel cursado',()=>{
  const route=read('routes/reportes.js');
  assert.match(route,/s\.nivel BETWEEN 7 AND 9 THEN 65 ELSE 70/);
  assert.match(route,/s\.nivel BETWEEN 7 AND 9 THEN 70 ELSE 75/);
  assert.match(route,/AS nota_minima/);
  assert.match(route,/AS limite_riesgo/);
});

test('las tarjetas muestran Normal, En riesgo y Críticos con límites dinámicos',()=>{
  const ui=read('public/index.html');
  assert.doesNotMatch(ui,/En buen estado/);
  assert.doesNotMatch(ui,/En riesgo \(60-79\)/);
  assert.match(ui,/Normal \(≥\$\{_limiteRiesgo\}\)/);
  assert.match(ui,/En riesgo \(\$\{_minima\}–&lt;\$\{_limiteRiesgo\}\)/);
  assert.match(ui,/Críticos \(&lt;\$\{_minima\}\)/);
});

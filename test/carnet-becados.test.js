const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');

test('el carnet becado se distingue únicamente mediante un fondo celeste claro',()=>{
  assert.match(html,/const esBecado = est\.becado === true/);
  assert.match(html,/linear-gradient\(180deg,#eefaff 0%,#d9f1ff 52%,#c7eaff 100%\)/);
  assert.match(html,/background:\$\{fondoCarnet\}/);
  assert.match(html,/tipoCarnet = esBecado \? 'celeste' : 'regular'/);

  const inicio=html.indexOf('function construirCarnetHTML(est)');
  const fin=html.indexOf('async function previewCarnetUno',inicio);
  const plantilla=html.slice(inicio,fin);
  assert.ok(inicio>=0&&fin>inicio,'No se encontró la plantilla del carnet');
  assert.doesNotMatch(plantilla,/textContent\s*=\s*['"]Becado/i);
  assert.doesNotMatch(plantilla,/>\s*Becad[oa]\s*</i);
});

test('el PDF conserva el color real del carnet y el código de barras queda blanco',()=>{
  assert.match(html,/backgroundColor:\s*"#ffffff"/);
  assert.match(html,/barWrap\.style\.cssText = `[\s\S]*?background:#fff/);
  assert.match(html,/background:\s*"#ffffff"/);
});

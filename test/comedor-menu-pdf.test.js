const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');

test('el reporte de comedor repite fecha y menú en el encabezado de cada página',()=>{
  const inicio=html.indexOf('async function imprimirReporteComedor()');
  const fin=html.indexOf('\nfunction alertComedor',inicio);
  const funcion=html.slice(inicio,fin);
  assert.match(funcion,/const encabezadoComedor=/);
  assert.match(funcion,/Menú del día/);
  assert.match(funcion,/Plato:/);
  assert.match(funcion,/Ensalada:/);
  assert.match(funcion,/Fruta:/);
  assert.match(funcion,/encabezadoExtraHTML:encabezadoComedor/);
  assert.match(html,/\$\{opciones\.encabezadoExtraHTML\|\|''\}/);
});

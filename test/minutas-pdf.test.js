const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const frontend=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const routes=fs.readFileSync(path.join(root,'routes','minutas.js'),'utf8');
const bloque=frontend.slice(frontend.indexOf('function minNombreImpresion'),frontend.indexOf('async function iniciarInventario'));

test('la minuta usa el generador PDF MEP nuevo y abandona la impresión HTML antigua',()=>{
  assert.match(bloque,/async function imprimirMinuta\(\)/);
  assert.match(bloque,/await imprimirPDFMEP\("MINUTA",contenidoHTML,`Minuta_\$\{numFmt\}\.pdf`\)/);
  assert.doesNotMatch(bloque,/window\.print\(/);
  assert.doesNotMatch(bloque,/w\.document\.write/);
});

test('el formato conserva colores, secciones, horas completas y pie oficial',()=>{
  assert.match(bloque,/background:#1F3864;color:#fff/);
  assert.match(bloque,/Temas tratados/);
  assert.match(bloque,/Acuerdos y compromisos/);
  assert.match(bloque,/Firma de participantes/);
  assert.match(bloque,/Finalización:/);
  assert.match(bloque,/minHoraImpresion\(m\.hora_fin\)/);
});

test('los nombres vinculados al sistema se imprimen nombre y dos apellidos',()=>{
  assert.match(routes,/u\.primer_apellido AS u_ap1/);
  assert.match(routes,/u\.segundo_apellido AS u_ap2/);
  assert.match(routes,/u\.nombre AS u_nombre/);
  assert.match(bloque,/nombreDesdeCampos\(persona\.u_nombre,persona\.u_ap1,persona\.u_ap2/);
  assert.match(bloque,/nombreDesdeCampos\(m\.ini_nombre,m\.ini_ap1,m\.ini_ap2/);
  assert.match(bloque,/htmlSeguro/);
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const raiz=path.join(__dirname,'..');
const leer=archivo=>fs.readFileSync(path.join(raiz,archivo),'utf8');

test('Debidos Procesos y Pautas buscan estudiantes en toda la institución',()=>{
  const estudiantes=leer('routes/estudiantes.js'),ui=leer('public/index.html');
  assert.match(estudiantes,/alcance==='procesos'&&rolesProcesos\.has/);
  assert.equal((ui.match(/\/api\/estudiantes\?alcance=procesos&q=/g)||[]).length,5);
});

test('todas las declaraciones reservan una página completa para firmas amplias',()=>{
  const ui=leer('public/index.html');
  assert.match(ui,/const crearPaginaFirmas=firmas=>/);
  assert.match(ui,/FIRMAS DE LA DECLARACIÓN/);
  assert.match(ui,/padding-top:82px;min-height:132px/);
  assert.match(ui,/if\(esDecl\) await imprimirPDFMEP\(tituloOficial, contenidoHTML, archivo,\{bloquesPagina:true\}\)/);
  assert.match(ui,/Firma de la persona estudiante/);
  assert.match(ui,/Firma de la persona docente declarante/);
});

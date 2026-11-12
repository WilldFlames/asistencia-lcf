const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const db=fs.readFileSync(path.join(root,'db.js'),'utf8');
const consecutivos=fs.readFileSync(path.join(root,'routes','consecutivos.js'),'utf8');
const conducta=fs.readFileSync(path.join(root,'routes','expedientesConducta.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');

test('Circular tiene serie independiente y reutiliza los campos administrativos del oficio',()=>{
  assert.match(db,/oficio','circular','minuta','proceso','protocolo/);
  assert.match(consecutivos,/circular:\s*1/);
  assert.match(html,/consec-opcion-circular/);
  assert.match(html,/tipo==='oficio'\|\|tipo==='circular'/);
  assert.match(html,/consec-destinatario/);
  assert.match(html,/consec-motivo-oficio/);
  assert.match(html,/consec-cargo-oficio/);
});

test('Circular se limita a Secretaría y los dos nombres históricos del comité evaluador',()=>{
  assert.match(consecutivos,/u\?\.rol==='secretaria'/);
  assert.match(consecutivos,/comite_evaluacion/);
  assert.match(consecutivos,/comite_tecnico_asesor/);
  assert.match(consecutivos,/Solo Secretaría y el Comité de Evaluación\/Técnico Asesor/);
  assert.match(html,/ME\.rol==='secretaria'.*comite_evaluacion.*comite_tecnico_asesor/);
});

test('Conducta ofrece un listado PDF con estado, apertura y última gestión',()=>{
  assert.match(conducta,/uc\.nombre AS creador_nombre/);
  assert.match(conducta,/LEFT JOIN LATERAL/);
  assert.match(conducta,/COALESCE\(ec\.cerrado_en,ult\.completado_en/);
  assert.match(html,/onclick="ectImprimirListado\(\)"/);
  assert.match(html,/LISTADO DE EXPEDIENTES DE CONDUCTA/);
  assert.match(html,/Última gestión \/ cierre/);
});

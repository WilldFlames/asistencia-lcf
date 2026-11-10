const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const tes=fs.readFileSync(path.join(root,'routes','expedientesConducta.js'),'utf8');

test('guardar notas reintenta una interrupción de red sin abandonar la evaluación',()=>{
  const inicio=html.indexOf('async function guardarNotas()');
  const fin=html.indexOf('// ── IMPRIMIR EVALUACIÓN',inicio);
  const guardar=html.slice(inicio,fin);
  assert.match(guardar,/while\(intentos<3\)/);
  assert.match(guardar,/failed to fetch\|networkerror\|load failed\|request aborted/i);
  assert.match(guardar,/Conexión recuperada\. Notas guardadas y confirmadas/);
  assert.match(guardar,/Las notas siguen en pantalla/);
  assert.match(guardar,/no necesita salir de la evaluación/);
});

test('las notificaciones TES fijan los tipos SQL de todos sus parámetros',()=>{
  assert.match(tes,/\$1::int,'tes_aprobacion',\$2::text,\$3::int,\$4::text/);
  assert.match(tes,/\$1::text,\$2::int,\$4::text/);
  assert.match(tes,/fi\.tipo=\$3::text/);
  assert.match(tes,/n\.referencia_id=\$2::int/);
});

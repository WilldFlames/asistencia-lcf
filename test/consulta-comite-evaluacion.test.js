const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const leer=r=>fs.readFileSync(path.join(root,r),'utf8');

test('Consulta da alcance institucional únicamente al comité evaluador activo',()=>{
  const helper=leer('utils/acceso-estudiantes.js');
  const estudiantes=leer('routes/estudiantes.js');
  const ui=leer('public/index.html');
  assert.match(helper,/function perteneceComiteEvaluacion/);
  assert.match(helper,/fi\.tipo IN \('comite_evaluacion','comite_tecnico_asesor'\)/);
  assert.match(helper,/u\.activo=true AND COALESCE\(u\.eliminado,false\)=false/);
  assert.match(estudiantes,/alcance==='consulta'&&await perteneceComiteEvaluacion/);
  assert.match(estudiantes,/accesoComite=!accesoSeccion&&await perteneceComiteEvaluacion/);
  assert.match(ui,/\/api\/estudiantes\?alcance=consulta&q=/);
});

test('la pertenencia al comité no se convierte en acceso total ni habilita edición',()=>{
  const helper=leer('utils/acceso-estudiantes.js');
  const inicio=helper.indexOf('function accesoTotal');
  const fin=helper.indexOf('async function perteneceComiteEvaluacion');
  const accesoTotal=helper.slice(inicio,fin);
  assert.doesNotMatch(accesoTotal,/comite_evaluacion|comite_tecnico_asesor/);
  assert.match(helper,/No se incorpora a accesoTotal/);
});

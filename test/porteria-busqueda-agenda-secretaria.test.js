const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('Portería busca estudiantes activos por nombre o cédula y permite seleccionarlos',()=>{
  const route=read('routes/porteria.js'),ui=read('public/index.html');
  assert.match(route,/router\.get\("\/buscar", canEscanear/);
  assert.match(route,/REGEXP_REPLACE\(e\.cedula/);
  assert.match(route,/CONCAT_WS\(' ',e\.nombre,e\.primer_apellido,e\.segundo_apellido\) ILIKE/);
  assert.match(route,/e\.activo=true AND COALESCE\(e\.archivado,false\)=false/);
  assert.match(ui,/id="pt-buscar-estudiante"/);
  assert.match(ui,/function ptProgramarBusqueda\(\)/);
  assert.match(ui,/api\(`\/api\/porteria\/buscar\?q=/);
  assert.match(ui,/function ptSeleccionarBusqueda\(cedula\)/);
});

test('Administración puede registrar compromisos personales en su agenda',()=>{
  const route=read('routes/agenda.js'),ui=read('public/index.html');
  assert.match(route,/compromisoPropio && !esOrientador\(u\) && !esAdmin\(u\)/);
  assert.match(ui,/puedePropio=tieneAlgunRol\('orientador'\)\|\|\['admin','administrativo'\]\.includes\(ME\.rol\)/);
  assert.match(ui,/agenda-btn-compromiso[\s\S]*Agendar compromiso propio/);
});

test('Secretaría tiene un flujo separado para compromisos personales propios o gestionados',()=>{
  const route=read('routes/agenda.js'),ui=read('public/index.html');
  assert.match(ui,/function agendaAbrirCompromisoPersonal\(\)/);
  assert.match(ui,/agendaAbrirNuevo\(false,true\)/);
  assert.match(ui,/compromiso_personal_secretaria:agendaEsCompromisoSecretaria/);
  assert.match(ui,/Este compromiso quedará confirmado directamente en la agenda seleccionada, sin invitaciones/);
  assert.match(route,/const compromisoSecretaria=req\.body\.compromiso_personal_secretaria===true/);
  assert.match(route,/compromisoSecretaria && !esSecretaria\(u\)/);
  assert.match(route,/compromisoSecretaria && participantes\.length/);
  assert.match(route,/compromisoSecretaria && institucional/);
});

test('Secretaría gestiona directamente docentes y Dirección con auditoría',()=>{
  const route=read('routes/agenda.js'),ui=read('public/index.html');
  assert.match(route,/const gestionadoPara=Number\(req\.body\.gestionado_para\)\|\|null/);
  assert.match(route,/\["profesor","profesor_guia","admin"\]\.includes\(personaGestionada\.rol\)/);
  assert.match(route,/const ids=\[\.\.\.new Set\(\[gestionadoPara\|\|u\.id,\.\.\.participantes\]\)\]/);
  assert.match(route,/Secretaría agregó a su agenda/);
  assert.match(ui,/id="ag-gestionar-para"/);
  assert.match(ui,/gestionado_para/);
});

test('los compromisos institucionales de Dirección se reflejan a docentes',()=>{
  const route=read('routes/agenda.js');
  assert.match(route,/e\.institucional=true AND \$5::boolean=true/);
  assert.match(route,/esAdmin\(req\.session\.usuario\)\|\|esDocenteAgenda\(req\.session\.usuario\)/);
  assert.match(route,/esSecretaria\(u\)&&personaGestionada\?\.rol==="admin"/);
});

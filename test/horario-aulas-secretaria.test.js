const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const leer=f=>fs.readFileSync(path.join(root,f),'utf8');

test('el aula acepta espacios institucionales y conserva los números existentes',()=>{
  const db=leer('db.js'),ruta=leer('routes/horarios.js'),ui=leer('public/index.html');
  assert.match(db,/aula\s+TEXT DEFAULT NULL/);
  assert.match(db,/ALTER COLUMN aula TYPE TEXT USING aula::text/);
  assert.match(db,/idx_horarios_aula_anio/);
  assert.match(ruta,/function nombreAula/);
  assert.match(ruta,/"Gimnasio A"/);
  assert.match(ruta,/"Lab Diseño Publicitario"/);
  assert.match(ui,/list="hor-aulas-opciones"/);
  assert.doesNotMatch(ui,/class="hor-aula hor-editor-room"[^>]+type="number"/);
});

test('secretaría y administración consultan la matriz dinámica del año permitido',()=>{
  const ruta=leer('routes/horarios.js');
  assert.match(ruta,/router\.get\("\/aulas", requireRol\("admin","secretaria"\)/);
  assert.match(ruta,/const anio=await anioVisiblePara\(req\)/);
  assert.match(ruta,/FROM horarios h[\s\S]*WHERE h\.anio=\$1/);
  assert.match(ruta,/UNION ALL[\s\S]*FROM horario_bloques_docente b/);
  assert.match(ruta,/res\.json\(\{anio,aulas:\[\.\.\.AULAS_BASE,\.\.\.adicionales\],celdas\}\)/);
  assert.match(ruta,/router\.get\("\/docentes", requireRol\("admin","secretaria"\)/);
  assert.match(ruta,/router\.get\("\/docente\/:id", requireRol\("admin","secretaria"\)/);
});

test('la interfaz de secretaría abre horarios y no habilita edición',()=>{
  const ui=leer('public/index.html');
  assert.match(ui,/esAdmin\|\|esProfesor\|\|esGuia\|\|esOrientador\|\|esAuxiliar\|\|esAdminIst\|\|esSecretaria/);
  assert.match(ui,/id="hor-btn-aulas"/);
  assert.match(ui,/const esSecretariaH = ME\.rol === 'secretaria'/);
  assert.match(ui,/return horVerAulas\(\)/);
  assert.match(ui,/document\.getElementById\('hor-bloques-admin'\)\.style\.display=ME\.rol==='admin'/);
  assert.match(ui,/document\.getElementById\('hor-btn-guardar'\)\.style\.display='none'/);
});

test('la matriz reproduce cinco días y doce lecciones y se imprime en legal horizontal',()=>{
  const ui=leer('public/index.html');
  assert.match(ui,/function horRenderMatrizAulas/);
  assert.match(ui,/HOR_DIAS\.slice\(1\)\.map/);
  assert.match(ui,/horLecciones\.map/);
  assert.match(ui,/function horImprimirAulas/);
  assert.match(ui,/@page\{size:legal landscape/);
  assert.match(ui,/posible\$\{r\.conflictos===1\?'':'s'\} cruce/);
});

test('los horarios de aula siguen el cambio anual sin copiar datos de ejemplo',()=>{
  const ui=leer('public/index.html'),ruta=leer('routes/horarios.js'),matricula=leer('routes/matricula.js');
  assert.match(ui,/api\(`\/api\/horarios\/aulas\?anio=\$\{anio\}`\)/);
  assert.match(ruta,/req\.session\?\.usuario\?\.rol==='admin' && solicitado \? solicitado : activo/);
  assert.match(matricula,/DELETE FROM horarios WHERE anio = \$1/);
  assert.doesNotMatch(ruta,/seccion_nombre\s*:\s*['"]\d+-\d+['"]/);
});

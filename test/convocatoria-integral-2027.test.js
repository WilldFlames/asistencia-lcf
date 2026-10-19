const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('convocatoria conserva expediente, materias y auditoría aun después del cierre anual',()=>{
  const db=read('db.js');
  assert.match(db,/CREATE TABLE IF NOT EXISTS convocatoria_expedientes/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS convocatoria_materias/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS convocatoria_eventos/);
  assert.match(db,/asignacion_id\s+INTEGER REFERENCES asignaciones\(id\) ON DELETE SET NULL/);
  assert.match(db,/UNIQUE\(estudiante_id,anio\)/);
});

test('la regla institucional usa seis en 7-9 y siete en 10-11, ignora materias sin nota y separa las semestrales',()=>{
  const route=read('routes/convocatoria.js');
  assert.match(route,/const limitePorNivel = nivel => Number\(nivel\) <= 9 \? 6 : 7/);
  assert.match(route,/const INICIO_REGLAS = 2027/);
  assert.match(route,/nota == null \|\| !Number\.isFinite/);
  assert.match(route,/Educación para el Hogar/);
  assert.match(route,/Artes Industriales/);
  assert.match(route,/Aunque[\s\S]*datos antiguos en ambos períodos[\s\S]*UNA asignatura/);
  assert.match(route,/if\(periodo!==periodoOrigen\) return/);
  assert.match(route,/m\.nombre NOT IN \('Guía','Orientación','Fortalecimiento Matemático'\)/);
  assert.match(route,/materia_nombre:"Conducta"/);
  assert.match(route,/resultado_tes==='aprobado'\?'aprobada'/);
  assert.match(route,/tes_pendiente/);
});

test('una exclusión por ausentismo se propaga sin revelar otra materia al docente',()=>{
  const route=read('routes/convocatoria.js');
  const ui=read('public/index.html');
  assert.match(route,/bloqueado_ausentismo/);
  assert.match(route,/sin_derecho_ausentismo/);
  assert.match(route,/sin_derecho_esta_materia/);
  assert.match(ui,/Esta asignatura originó una marca sin derecho por ausentismo/);
  assert.match(ui,/Por confidencialidad, al docente solo se le muestra el asterisco/);
});

test('2026 es informativo y desde 2027 matrícula obedece la condición final',()=>{
  const route=read('routes/convocatoria.js');
  const matricula=read('routes/matricula.js');
  assert.match(route,/modo_informativo:Number\(anio\)<INICIO_REGLAS/);
  assert.match(matricula,/FROM convocatoria_expedientes WHERE estudiante_id=\$1 AND anio=\$2/);
  assert.match(matricula,/Puede completar la matrícula provisional, pero no elegir sección/);
  assert.match(matricula,/debe repetir \$\{control\.nivel\}°/);
});

test('docente solo ve su materia y administración conserva el control cruzado',()=>{
  const route=read('routes/convocatoria.js');
  assert.match(route,/if\(!esGestion\(u\)\).*cm\.profesor_id/);
  assert.match(route,/Solo el docente responsable o Administración puede registrar este resultado/);
  assert.match(route,/pendientes\.length === 1 && cumple \? "estrategia_pendiente"/);
});

test('administración y auxiliares ven una fila por estudiante y despliegan sus materias',()=>{
  const ui=read('public/index.html');
  assert.match(ui,/if\(convData\.ve_detalle\)\{convRenderGestion\(base,est\);return;\}/);
  assert.match(ui,/function convRenderGestion\(filas,estadoFiltro=''/);
  assert.match(ui,/const porSeccion=new Map/);
  assert.match(ui,/Sección \$\{htmlSeguro\(seccion\)\} · \$\{grupos\.length\} estudiante\(s\)/);
  assert.match(ui,/Ver materias \(\$\{g\.materias\.length\}\)/);
  assert.match(ui,/Conducta está incluida una sola vez en el total/);
});

test('la interfaz identifica el modo prueba y no revela materias ajenas al docente',()=>{
  const ui=read('public/index.html');
  assert.match(ui,/id="nav-convocatoria"/);
  assert.match(ui,/modo informativo/);
  assert.match(ui,/convData\.ve_detalle\?/);
  assert.match(ui,/Materias académicas visibles en Convocatoria/);
});

test('el listado informativo se construye al abrir y se agrupa por sección',()=>{
  const route=read('routes/convocatoria.js');
  const ui=read('public/index.html');
  assert.match(route,/const sincroniza = staff/);
  assert.match(route,/tieneNotaRegistrada/);
  assert.match(route,/incidencias:incidencias\.length/);
  assert.match(ui,/await convCargar\(false\);[\s\S]*await convSincronizarAutomatico\(\)/);
  assert.match(ui,/Actualizando automáticamente las convocatorias/);
  assert.match(ui,/const porSeccion=new Map/);
  assert.match(ui,/Sección \$\{htmlSeguro\(seccion\)\}/);
});

test('el recálculo evita revisar asignaciones vacías y limita al docente autenticado',()=>{
  const route=read('routes/convocatoria.js');
  assert.match(route,/periodos_con_notas/);
  assert.match(route,/EXISTS\(SELECT 1 FROM notas_examen/);
  assert.match(route,/EXISTS\(SELECT 1 FROM notas_indicador/);
  assert.match(route,/profesorFiltro=esGestion\(u\)\?null:Number\(u\.id\)/);
  assert.match(route,/Math\.min\(4,Math\.max\(1,trabajos\.length\)\)/);
  assert.match(route,/grupos_revisados:grupos\.length/);
});

test('la auditoría de convocatoria declara los tipos que PostgreSQL guarda en JSON',()=>{
  const route=read('routes/convocatoria.js');
  assert.match(route,/'total_aplazadas',\$2::integer/);
  assert.match(route,/'modo_informativo',\$3::boolean/);
  assert.match(route,/'nota',\$4::numeric/);
  assert.match(route,/'fecha',\$5::date/);
});

test('dos recálculos simultáneos no pueden bloquearse entre sí',()=>{
  const route=read('routes/convocatoria.js');
  assert.match(route,/pg_advisory_xact_lock\(\$1::integer,\$2::integer\)/);
  assert.match(route,/const estudiantesOrdenados=\[\.\.\.estudiantes\.entries\(\)\]/);
  assert.match(route,/sort\(\(a,b\)=>Number\(a\[0\]\)-Number\(b\[0\]\)\)/);
  assert.match(route,/sincronización \$\{anio\} completada/);
});

test('el recálculo de un docente no elimina ni sustituye materias ajenas',()=>{
  const route=read('routes/convocatoria.js');
  assert.match(route,/\$2::integer IS NULL OR cm\.profesor_id=\$2::integer/);
  assert.match(route,/CASE WHEN \$11::boolean THEN convocatoria_expedientes\.total_aplazadas/);
  assert.match(route,/total_aplazadas=\(SELECT COUNT\(\*\)::integer FROM convocatoria_materias/);
  assert.match(route,/clavesVigentes=fallos\.map/);
});

test('las secciones existen aunque todavía no haya expedientes y la carga es automática',()=>{
  const route=read('routes/convocatoria.js');
  const ui=read('public/index.html');
  assert.match(route,/SELECT s\.id,s\.nombre,s\.nivel FROM secciones s[\s\S]*JOIN secciones_anio sa/);
  assert.match(route,/SELECT DISTINCT s\.id,s\.nombre,s\.nivel[\s\S]*FROM asignaciones a/);
  assert.match(route,/secciones,filas/);
  assert.match(ui,/await convCargar\(false\);[\s\S]*await convSincronizarAutomatico\(\)/);
  assert.match(ui,/Actualizando automáticamente las convocatorias/);
  assert.match(ui,/convData\.secciones\|\|\[\]/);
});

test('Conducta cuenta para el límite pero se consulta únicamente en su propio módulo',()=>{
  const route=read('routes/convocatoria.js');
  const ui=read('public/index.html');
  assert.match(route,/materia_nombre:"Conducta"/);
  assert.match(route,/total_aplazadas=\(SELECT COUNT\(\*\)::integer FROM convocatoria_materias/);
  assert.match(route,/cm\.materia_nombre<>'Conducta'/);
  assert.match(ui,/Conducta está incluida una sola vez en ese total/);
  assert.match(ui,/se consulta y resuelve desde Expedientes de Conducta/);
});

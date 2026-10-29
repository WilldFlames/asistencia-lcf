const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('horario especial pertenece únicamente a administración y auxiliares',()=>{
  const ruta=read('routes/horarioEspecial.js');
  const html=read('public/index.html');
  assert.match(ruta,/requireRol\("admin", "auxiliar"\)/);
  assert.match(html,/if\(esAdmin\|\|esAuxiliar\)[\s\S]*nav-horario-especial/);
  assert.match(ruta,/UNIQUE\(fecha,seccion_id\)|ON CONFLICT\(fecha,seccion_id\)/);
});

test('portería aplica jornada efectiva, tolerancia y alerta de identidad',()=>{
  const ruta=read('routes/porteria.js');
  const db=read('db.js');
  const html=read('public/index.html');
  assert.match(ruta,/async function jornadaHoy/);
  assert.match(ruta,/restarMinutos\(jornada\.horaInicio,20\)/);
  assert.match(ruta,/codigo:"entrada_temprana"/);
  assert.match(ruta,/codigo:"sin_horario"/);
  assert.match(ruta,/codigo:"identificacion_desconocida"/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS porteria_intentos_desconocidos/);
  assert.match(html,/pt-critical-flash/);
});

test('el informe identifica quién registró entrada y salida',()=>{
  const ruta=read('routes/porteria.js');
  const html=read('public/index.html');
  assert.match(ruta,/u\.nombre AS registro_nombre/);
  assert.match(html,/Entrada registrada por:/);
  assert.match(html,/Salida registrada por:/);
});

test('la ausencia docente se refleja en la jornada familiar',()=>{
  const db=read('db.js');
  const padres=read('routes/padres.js');
  const html=read('public/index.html');
  assert.match(db,/CREATE TABLE IF NOT EXISTS docente_ausencias/);
  assert.match(padres,/LEFT JOIN LATERAL[\s\S]*docente_ausencias/);
  assert.match(html,/Docente ausente/);
});

test('una sección puede quedar sin jornada en una fecha y bloquear el ingreso',()=>{
  const db=read('db.js');
  const ruta=read('routes/horarioEspecial.js');
  const porteria=read('routes/porteria.js');
  const padres=read('routes/padres.js');
  const html=read('public/index.html');
  assert.match(db,/ADD COLUMN IF NOT EXISTS sin_horario BOOLEAN DEFAULT false/);
  assert.match(ruta,/sinHorario=req\.body\.sin_horario===true/);
  assert.match(porteria,/jornada\.especial\?\.sin_horario/);
  assert.match(padres,/sin_horario:true/);
  assert.match(html,/La sección no tiene jornada ese día/);
  assert.match(html,/Registrado por/);
});

test('el horario especial crea un aviso familiar permanente y una notificación',()=>{
  const db=read('db.js');
  const ruta=read('routes/horarioEspecial.js');
  const padres=read('routes/padres.js');
  assert.match(db,/ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS tipo_origen/);
  assert.match(db,/anuncios_origen_uq/);
  assert.match(ruta,/INSERT INTO anuncios[\s\S]*'horario_especial'/);
  assert.match(ruta,/notificarSecciones\(\[seccionId\]/);
  assert.match(ruta,/await client\.query\("COMMIT"\)/);
  assert.match(padres,/a\.para_todos=true OR a\.secciones && \$1::int\[\]/);
});

test('cada movimiento de Portería deja aviso privado aunque el push falle',()=>{
  const db=read('db.js');
  const ruta=read('routes/porteria.js');
  const padres=read('routes/padres.js');
  assert.match(db,/CREATE TABLE IF NOT EXISTS avisos_familia/);
  assert.match(ruta,/INSERT INTO avisos_familia/);
  assert.match(ruta,/ON CONFLICT\(clave\) DO NOTHING/);
  assert.match(ruta,/Aviso de Portería no enviado/);
  assert.match(padres,/FROM avisos_familia af WHERE af\.estudiante_id=ANY/);
  assert.match(ruta,/codigo:"sin_horario"[\s\S]*notificarMovimientoPorteria/);
});

test('el informe de Portería separa el alcance de guías y personal institucional',()=>{
  const ruta=read('routes/porteria.js');
  const html=read('public/index.html');
  assert.match(ruta,/const canInforme\s*= requireRol\("admin","auxiliar","administrativo","profesor_guia","orientador"\)/);
  assert.match(ruta,/function accesoTotalInforme[\s\S]*"orientador"/);
  assert.match(ruta,/seccion_guia_anio sga[\s\S]*sga\.profesor_id=\$1/);
  assert.doesNotMatch(ruta,/sga\.guia_id|sg\.guia_id/);
  assert.match(ruta,/router\.get\("\/informe-opciones", canInforme/);
  assert.match(ruta,/router\.get\("\/informe-estudiantes", canInforme/);
  assert.match(ruta,/const canVer\s*= requireRol\("admin","seguridad"\)/);
  assert.match(ruta,/router\.get\("\/registros", canVer/);
  assert.match(ruta,/router\.get\("\/stats", canVer/);
  assert.match(html,/const soloInforme=!\['admin','seguridad'\]\.includes\(ME\.rol\)/);
  assert.match(html,/id="pt-inf-seccion"/);
  assert.match(html,/id="pt-inf-estudiante"/);
  assert.match(html,/ptCargarEstudiantesInforme/);
  assert.match(html,/estudiante_id=\$\{encodeURIComponent\(estudianteId\)\}/);
});

test('la constancia de retiro agrega el acta legal para personas menores de edad',()=>{
  const html=read('public/index.html');
  assert.match(html,/ACTA DE RETIRO VOLUNTARIO DE ESTUDIANTE/);
  assert.match(html,/DECLARACIÓN DE RESPONSABILIDAD Y ADVERTENCIA LEGAL/);
  assert.match(html,/artículo 78 de la Constitución Política/);
  assert.match(html,/artículos 65, 66 y 130 del Código de la Niñez y la Adolescencia/);
  assert.match(html,/cfgCentro=await api\('\/api\/protocolos\/config-centro'\)/);
  assert.match(html,/const contenidoHTML=constanciaHTML\+actaMenorHTML/);
  assert.match(html,/constancia_retiro_\$\{est\.cedula\}\.pdf`,\{bloquesPagina:true\}/);
  assert.match(html,/class="retiro-firmas-amplias"/);
  assert.match(html,/margin-top:76px;page-break-inside:avoid/);
  assert.match(html,/margin-top:38px;text-align:center;page-break-inside:avoid/);
});

test('el autoguardado de asistencia serializa peticiones y reintenta errores',()=>{
  const html=read('public/index.html');
  assert.match(html,/if\(asistenciaAutosaveEnCurso\)/);
  assert.match(html,/contextoEnviado===asistenciaContextoVersion/);
  assert.match(html,/No se pudo guardar; se reintentará automáticamente/);
  assert.match(html,/id="asis-btn-guardar"/);
});

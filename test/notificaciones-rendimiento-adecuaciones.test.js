const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('las notificaciones se entregan sin esperar a que la familia abra la app', () => {
  const rutas = ['routes/anuncios.js','routes/asistencia.js','routes/conducta.js','routes/estudiantes.js','routes/citas.js','routes/porteria.js'];
  for (const ruta of rutas) {
    const src = read(ruta);
    assert.doesNotMatch(src, /void\s+notificar/);
    assert.match(src, /await\s+notificar/);
  }
  const sw = read('public/sw.js');
  assert.match(sw, /notificationclick/);
  assert.match(sw, /clients\.openWindow/);
  assert.match(sw, /LCF_OPEN_NOTIFICATION/);
});

test('una suscripción activada no ofrece desactivación desde el portal', () => {
  const pwa = read('public/pwa.js');
  const padres = read('routes/padres.js');
  assert.match(pwa, /botonPush\.hidden\s*=\s*tipo\s*===\s*"active"/);
  assert.doesNotMatch(pwa, /unsubscribe\s*\(/);
  assert.doesNotMatch(padres, /router\.delete\("\/push\/suscribir"/);
});

test('el acceso de familias depende del pago habilitado por la institución', () => {
  const db = read('db.js');
  const padres = read('routes/padres.js');
  const admin = read('routes/admin.js');
  assert.match(db, /servicio_habilitado BOOLEAN DEFAULT false/);
  assert.match(padres, /servicio_habilitado/);
  assert.match(admin, /\/padres\/:cedula\/servicio/);
});

test('coordinación tiene Rendimiento y solo edita Educación Híbrida', () => {
  const rendimiento = read('routes/rendimiento.js');
  const medidas = read('routes/medidas.js');
  const ui = read('public/index.html');
  assert.match(rendimiento, /nivel\)>=10\?70:65/);
  assert.match(rendimiento, /porcentaje_aprobacion/);
  assert.match(rendimiento, /NULLIF\(\$2::numeric,0\)/);
  assert.match(medidas, /coordinador/);
  assert.match(medidas, /educacion_hibrida/);
  assert.match(ui, /id="page-rendimiento"/);
  assert.match(ui, /function rendGraficaCircular/);
  assert.match(ui, /function rendGraficaExamenes/);
  assert.match(ui, /function rendGraficaDistribucion/);
  assert.match(ui, /rend-graficas/);
  assert.match(ui, /window\.puedeEditarMedida/);
  assert.match(rendimiento, /Seleccione al menos una sección o una materia/);
  assert.doesNotMatch(ui, /rendimientoFiltrosCargados=true;[\s\S]{0,180}await cargarRendimiento\(\)/);
});

test('el Comité de Apoyo administra tres adecuaciones y solicitudes auditables', () => {
  const db = read('db.js');
  const ruta = read('routes/adecuaciones.js');
  const ui = read('public/index.html');
  assert.match(db, /CREATE TABLE IF NOT EXISTS adecuaciones_estudiante/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS solicitudes_adecuacion_docente/);
  for (const tipo of ['no_significativa','significativa','acceso']) assert.match(ruta, new RegExp(tipo));
  assert.match(ruta, /\/solicitudes\/:id\/resolver/);
  assert.match(ruta, /decision==="aprobada"|decision === "aprobada"/);
  assert.match(ui, /function badgeAdecuacion/);
  assert.match(ui, /Imprimir lista completa/);
  assert.match(ui, /El Comité de Apoyo no ha marcado estudiantes con adecuación en esta sección/);
  assert.match(ruta, /JOIN secciones_anio sa ON sa\.seccion_id=s\.id AND sa\.anio=\$1 AND sa\.activa=true/);
  assert.doesNotMatch(ruta, /FROM secciones\s+WHERE COALESCE\(activa/);
  assert.match(ruta, /WHERE a\.profesor_id=\$1 AND COALESCE\(a\.anio,\$2\)=\$2/);
  assert.match(ruta, /JOIN secciones_anio sa ON sa\.seccion_id=s\.id AND sa\.anio=\$2 AND sa\.activa=true/);
  assert.match(ruta, /JOIN adecuaciones_estudiante ad ON ad\.estudiante_id=e\.id/);
  assert.match(ruta, /AND \(ad\.no_significativa OR ad\.significativa OR ad\.acceso\)/);
  assert.match(ruta, /EXISTS \([\s\S]*?a\.profesor_id=\$2[\s\S]*?UPPER\(a\.subgrupo\)=UPPER\(COALESCE\(e\.subgrupo,''\)\)/);
});

test('LCF Familias es una función independiente asignada por el administrador', () => {
  const db = read('db.js');
  const admin = read('routes/admin.js');
  const ui = read('public/index.html');
  assert.match(db, /'coordinador','comite_apoyo','lcf_familias'/);
  assert.match(admin, /tipo='lcf_familias'/);
  assert.doesNotMatch(admin, /SELECT 1 FROM matricula_comite WHERE usuario_id=\$1/);
  assert.match(admin, /router\.get\("\/padres\/buscar", canGestionarPadres/);
  assert.match(admin, /router\.put\("\/padres\/:cedula\/servicio", canGestionarPadres/);
  assert.match(admin, /router\.put\("\/padres\/:cedula\/reset-password", canAdministrarSeguridadPadres/);
  assert.match(admin, /router\.put\("\/padres\/:cedula\/toggle-activo", canAdministrarSeguridadPadres/);
  assert.match(admin, /router\.put\("\/padres\/:cedula\/cerrar-sesion", canAdministrarSeguridadPadres/);
  assert.match(admin, /const canAdministrarSeguridadPadres = canGestionarPadres/);
  assert.match(ui, /id="nav-gestion-padres"/);
  assert.match(ui, /function tieneAccesoLCFFamilias/);
  assert.match(ui, /tarjetaDashboardLCFFamilias/);
  assert.match(ui, /abrirFuncionInstitucional\('lcf_familias'\)/);
  assert.match(ui, /Comité matrícula → puede ver Prematrícula y Matrícula\.[\s\S]{0,120}LCF Familias se asigna por separado/);
  assert.match(ui, /const puedeSeguridad = tieneAccesoLCFFamilias\(\)/);
});

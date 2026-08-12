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
  assert.match(medidas, /coordinador/);
  assert.match(medidas, /educacion_hibrida/);
  assert.match(ui, /id="page-rendimiento"/);
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
  assert.match(ruta, /JOIN secciones_anio sa ON sa\.seccion_id=s\.id AND sa\.anio=\$1 AND sa\.activa=true/);
  assert.doesNotMatch(ruta, /FROM secciones\s+WHERE COALESCE\(activa/);
});

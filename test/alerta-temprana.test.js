const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Alerta Temprana conserva expediente, seguimientos, plan y contactos', () => {
  const db = read('db.js');
  for (const tabla of ['alertas_tempranas','alerta_temprana_seguimientos','alerta_temprana_acciones','alerta_temprana_contactos']) {
    assert.match(db, new RegExp(`CREATE TABLE IF NOT EXISTS ${tabla}`));
  }
  assert.match(db, /estado IN \('activada','en_proceso','en_espera','cerrada','eliminada'\)/);
  assert.match(db, /alerta_temprana_activa_por_asignacion/);
});

test('solo el docente propietario modifica y la supervisión institucional lee', () => {
  const ruta = read('routes/alertaTemprana.js');
  assert.match(ruta, /\["admin","auxiliar","administrativo"\]/);
  assert.match(ruta, /tipo='coordinador'/);
  assert.match(ruta, /La supervisión institucional es de solo lectura/);
  assert.match(ruta, /alerta\.profesor_id!==u\.id/);
  assert.match(ruta, /asignacionPropia\(u\.id,asignacionId,estudianteId\)/);
});

test('cada llamada queda en historial y se enlaza automáticamente a una alerta abierta', () => {
  const db = read('db.js');
  const ruta = read('routes/alertaTemprana.js');
  assert.match(db, /CREATE TABLE IF NOT EXISTS registro_llamadas/);
  assert.match(ruta, /estado NOT IN \('cerrada','eliminada'\)/);
  assert.match(ruta, /INSERT INTO alerta_temprana_contactos\(alerta_id,llamada_id/);
  assert.match(ruta, /ORDER BY rl\.fecha DESC,rl\.hora_inicio DESC/);
});

test('los seguimientos notifican a auxiliares, coordinación y administración con destino directo', () => {
  const db = read('db.js');
  const ruta = read('routes/alertaTemprana.js');
  const ui = read('public/index.html');
  assert.match(db, /notificaciones ADD COLUMN IF NOT EXISTS destino/);
  assert.match(ruta, /await notificarSupervision/);
  assert.match(ruta, /alerta-temprana:\$\{alertaId\}/);
  assert.match(ui, /destino\.startsWith\("alerta-temprana:"\)/);
  assert.match(ui, /atVerDetalle\(alertaId\)/);
});

test('la interfaz incluye boletas visuales, registro consolidado y Excel MEP', () => {
  const ui = read('public/index.html');
  assert.match(ui, /id="page-alerta-temprana"/);
  assert.match(ui, /function atAgregarSeguimiento/);
  assert.match(ui, /function atAgregarAccion/);
  assert.match(ui, /function atAgregarContacto/);
  assert.match(ui, /function atImprimirConsolidado/);
  assert.match(ui, /estudianteUnico=q&&estudiantes\.size===1/);
  assert.match(ui, /Imprimir consolidado de \$\{estudianteUnico\.estudiante_nombre\}/);
  assert.match(ui, /function atDescargarExcel/);
  assert.ok(fs.existsSync(path.join(root,'public','assets','alerta-temprana-mep.xlsx')));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ruta = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estudiantes.js'), 'utf8');

test('los movimientos de estudiantes respetan el subgrupo de cada asignación', () => {
  assert.match(ruta, /function profesoresParaMovimientoEstudiante/);
  assert.match(ruta, /COALESCE\(a\.subgrupo,''\)=''/);
  assert.match(ruta, /COALESCE\(\$2::text,''\)=''/);
  assert.match(ruta, /UPPER\(a\.subgrupo\)=UPPER\(\$2::text\)/);
});

test('el profesor guía conserva los avisos de toda su sección', () => {
  assert.match(ruta, /SELECT sg\.profesor_id AS destinatario_id/);
  assert.match(ruta, /FROM seccion_guia sg/);
  assert.match(ruta, /sg\.seccion_id=\$1/);
});

test('ingresos, traslados, retiros y reactivaciones usan el filtro común', () => {
  for (const llamada of [
    "notificarMovimientoEstudiante(seccion_id, subgrupo, msg, 'reingreso_estudiante')",
    "notificarMovimientoEstudiante(seccion_id, subgrupo, msg, 'nuevo_estudiante')",
    "notificarMovimientoEstudiante(seccionAnteriorId, est.subgrupo, msgAnterior, 'cambio_seccion')",
    "notificarMovimientoEstudiante(seccion_id, est.subgrupo, msgNueva, 'cambio_seccion')",
    'notificarMovimientoEstudiante(est.sec_id, est.subgrupo, msg, "archivo_estudiante")',
    'notificarMovimientoEstudiante(secNueva.id, est.subgrupo, msg, "reactivacion_estudiante", u.id)'
  ]) assert.ok(ruta.includes(llamada), `Falta aplicar el filtro en: ${llamada}`);
});

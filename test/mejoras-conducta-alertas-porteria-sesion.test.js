const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const raiz = path.join(__dirname, "..");
const leer = archivo => fs.readFileSync(path.join(raiz, archivo), "utf8");

test("Orientación consulta Conducta en sus secciones sin poder modificar boletas", () => {
  const reportes = leer("routes/reportes.js");
  const conducta = leer("routes/conducta.js");
  const ui = leer("public/index.html");
  assert.match(reportes, /FROM seccion_orientador so JOIN secciones s/);
  assert.match(reportes, /Consulta de Orientación/);
  assert.match(conducta, /const canManage = requireRol\("admin","auxiliar","profesor_guia"\)/);
  assert.doesNotMatch(conducta, /const canManage = requireRol\([^\n]*"orientador"/);
  assert.match(ui, /condSoloLectura=tieneAlgunRol\('orientador'\)/);
});

test("Auxiliares abren alertas y llamadas por sección sin necesitar asignación docente", () => {
  const ruta = leer("routes/alertaTemprana.js");
  assert.match(ruta, /function puedeCrear\(u\)\{return esDocente\(u\)\|\|esAuxiliar\(u\);\}/);
  assert.match(ruta, /'aux:'\|\|s\.id/);
  assert.match(ruta, /'Actuación de Auxiliar'::text AS materia_nombre/);
  assert.match(ruta, /materia_id IS NOT DISTINCT FROM \$4::int/);
});

test("Alertas retiradas permanecen visibles y los filtros nacen de expedientes existentes", () => {
  const ruta = leer("routes/alertaTemprana.js");
  const ui = leer("public/index.html");
  assert.match(ruta, /\(NOT e\.activo OR COALESCE\(e\.archivado,false\)\) AS estudiante_retirado/);
  assert.match(ui, /id="at-alertas-seccion"/);
  assert.match(ui, /id="at-alertas-estudiante"/);
  assert.match(ui, /a\.estudiante_retirado\?'<span class="badge b-admin">RETIRADO<\/span>'/);
  assert.match(ui, /const sel=document\.getElementById\('at-alertas-seccion'\).*secciones=new Map\(\)/);
});

test("La resolución del debido proceso se identifica en Conducta y la carta usa el PDF MEP", () => {
  const conducta = leer("routes/conducta.js");
  const ui = leer("public/index.html");
  assert.match(conducta, /LEFT JOIN debidos_procesos dp ON dp\.id = b\.debido_proceso_id/);
  assert.match(ui, /Aplicado por resolución del expediente N°/);
  assert.match(ui, /NOTIFICACIÓN DE CONDICIÓN DE APLAZADO EN CONDUCTA/);
  assert.match(ui, /await imprimirPDFMEP\('NOTIFICACIÓN DE CONDICIÓN DE APLAZADO EN CONDUCTA'/);
});

test("Portería notifica movimientos y la sesión móvil se renueva por actividad", () => {
  const porteria = leer("routes/porteria.js");
  const server = leer("server.js");
  assert.match(porteria, /async function notificarMovimientoPorteria/);
  assert.match(porteria, /await notificarMovimientoPorteria\(est\.id,"entrada",hora\)/);
  assert.match(porteria, /await notificarMovimientoPorteria\(est\.id,"salida",hora/);
  assert.match(server, /rolling:\s*true/);
  assert.match(server, /maxAge:\s*30 \* 24 \* 60 \* 60 \* 1000/);
});

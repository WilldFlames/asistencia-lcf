const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const raiz = path.join(__dirname, "..");
const leer = archivo => fs.readFileSync(path.join(raiz, archivo), "utf8");
const db = leer("db.js");
const matricula = leer("routes/matricula.js");
const config = leer("routes/configAnio.js");
const horarios = leer("routes/horarios.js");
const admin = leer("routes/admin.js");
const frontend = leer("public/index.html");

test("la configuración académica está separada por curso lectivo", () => {
  for (const tabla of [
    "anios_lectivos", "cierres_anio", "secciones_anio",
    "seccion_guia_anio", "seccion_orientador_anio"
  ]) assert.match(db, new RegExp(`CREATE TABLE IF NOT EXISTS ${tabla}`));

  assert.match(db, /asignaciones_unique_anio/);
  assert.match(config, /JOIN secciones_anio/);
  assert.match(config, /LEFT JOIN seccion_guia_anio/);
  assert.match(config, /LEFT JOIN seccion_orientador_anio/);
});

test("el cambio de año es revisable, atómico e idempotente", () => {
  assert.match(matricula, /previsualizar-aplicar/);
  assert.match(matricula, /pg_advisory_xact_lock/);
  assert.match(matricula, /SELECT aplicado_at FROM cierres_anio/);
  assert.match(matricula, /INSERT INTO cierres_anio/);
  assert.match(matricula, /DELETE FROM boletas_conducta WHERE EXTRACT\(YEAR FROM fecha\)::int=\$1/);
  assert.match(matricula, /WHERE a\.anio = \$1/);
  assert.match(matricula, /UPDATE anios_lectivos SET estado='cerrado'/);
  assert.match(matricula, /UPDATE anios_lectivos SET estado='activo'/);
});

test("los horarios y sus asignaciones validan sección y año", () => {
  assert.match(horarios, /a\.anio = \$2/);
  assert.match(horarios, /seccion_id=\$2 AND anio=\$3/);
  assert.match(horarios, /seccion_guia_anio/);
});

test("solo administración puede ver asignaciones, secciones y horarios futuros", () => {
  assert.match(horarios, /async function anioVisiblePara/);
  assert.match(horarios, /req\.session\?\.usuario\?\.rol==='admin'/);
  assert.match(admin, /req\.session\?\.usuario\?\.rol === 'admin' && solicitado/);
  assert.match(frontend, /anioInput\.disabled = !esAdminH/);
  assert.match(frontend, /Los profesores, guías y[\s\S]*curso lectivo activo/);
});

test("el frontend usa el año activo y el calendario configurado", () => {
  assert.match(frontend, /ANIO_LECTIVO_ACTIVO/);
  assert.match(frontend, /CALENDARIO_LECTIVO/);
  assert.match(frontend, /config-anio\/vigente/);
  assert.match(frontend, /previsualizar-aplicar/);
  assert.match(frontend, /rangoPeriodoFrontend/);
  assert.doesNotMatch(frontend, /Fechas Clave 2026/);
});

test("todos los bloques JavaScript del HTML conservan sintaxis válida", () => {
  const bloques = [...frontend.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).filter(codigo => codigo.trim());
  // La aplicación mantiene un único bloque principal; las etiquetas <script>
  // adicionales visibles en el texto pertenecen a plantillas de impresión.
  assert.ok(bloques.length >= 1);
  bloques.forEach((codigo, i) => assert.doesNotThrow(
    () => new vm.Script(codigo, { filename: `index-inline-${i + 1}.js` })
  ));
});

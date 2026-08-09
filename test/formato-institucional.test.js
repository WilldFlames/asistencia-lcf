const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const raiz = path.join(__dirname, "..");
const frontend = fs.readFileSync(path.join(raiz, "public", "index.html"), "utf8");
const calificaciones = fs.readFileSync(path.join(raiz, "routes", "calificaciones.js"), "utf8");
const estudiantes = fs.readFileSync(path.join(raiz, "routes", "estudiantes.js"), "utf8");
const db = fs.readFileSync(path.join(raiz, "db.js"), "utf8");

test("los nombres visibles usan nombre, primer apellido y segundo apellido", () => {
  assert.match(frontend, /const partes=\[persona\.nombre,persona\.primer_apellido,persona\.segundo_apellido\]/);
  assert.match(frontend, /function nombreDesdeCampos\(nombre,primerApellido,segundoApellido/);
  assert.match(frontend, /const profNombre = nombrePersona\(ME\)/);
  assert.match(frontend, /const nombreCompleto = nombrePersona\(e\)/);
});

test("los botones de ojo usan una ventana institucional y no un alert de contenido", () => {
  assert.match(frontend, /id="modal-detalle-institucional"/);
  assert.match(frontend, /async function verPremat\(id\)[\s\S]*?abrirDetalleInstitucional/);
  assert.match(frontend, /function verMedida\(id, tipo\)[\s\S]*?abrirDetalleInstitucional/);

  const verPremat = frontend.match(/async function verPremat\(id\)([\s\S]*?)\n}\n\nasync function reimprimir/);
  const verMedida = frontend.match(/function verMedida\(id, tipo\)([\s\S]*?)\n}\n/);
  assert.ok(verPremat && !/alert\s*\(/.test(verPremat[1]));
  assert.ok(verMedida && !/alert\s*\(/.test(verMedida[1]));
});

test("las fechas institucionales se muestran como día, mes y año", () => {
  assert.match(frontend, /return `\$\{dia\}\/\$\{m\}\/\$\{y\}`/);
  assert.match(frontend, /filaDetalle\('Fecha de nacimiento',fmtF\(p\.fecha_nacimiento\)\)/);
  assert.match(frontend, /<strong>Fecha de emisión:<\/strong> \$\{fmtF\(fechaHoyCR\(\)\)\}/);
});

test("el acta de promedios recibe e imprime la sección", () => {
  assert.match(calificaciones, /s\.nombre AS seccion_nombre/);
  assert.match(frontend, /<strong>Sección:<\/strong> \$\{a\.seccion_nombre\}/);
});

test("los expedientes archivados conservan la sección que tenían", () => {
  assert.match(db, /ADD COLUMN IF NOT EXISTS seccion_archivo TEXT/);
  assert.match(db, /he\.valor_anterior ILIKE 'Activo en %'/);
  assert.match(estudiantes, /COALESCE\(s\.nombre, e\.seccion_archivo\) AS seccion_nombre/);
  assert.match(estudiantes, /seccion_archivo=\$4,[\s\S]*seccion_id=NULL/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const raiz = path.join(__dirname, "..");
const leer = archivo => fs.readFileSync(path.join(raiz, archivo), "utf8");
const db = leer("db.js");
const rutas = leer("routes/alertaTemprana.js");
const frontend = leer("public/index.html");
const { CARACTERIZACION_CATALOGO } = require("../utils/catalogoCaracterizacion");

test("el catálogo usa las 87 caracterizaciones de la segunda columna suministrada", () => {
  assert.equal(CARACTERIZACION_CATALOGO.length, 87);
  assert.deepEqual(CARACTERIZACION_CATALOGO.map(x => x.codigo), Array.from({ length: 87 }, (_, i) => i + 1));
  assert.equal(CARACTERIZACION_CATALOGO[0].descripcion, "Ausentismo por día en preescolar y primaria.");
  assert.equal(CARACTERIZACION_CATALOGO[86].descripcion, "Estudiante privado de libertad, libertad condicional o sanciones alternativas.");
});

test("la caracterización es anual, auditable y permanece ligada al estudiante", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS caracterizaciones_poblacion/);
  assert.match(db, /PRIMARY KEY\(anio,estudiante_id,codigo\)/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS caracterizaciones_poblacion_auditoria/);
  assert.match(rutas, /aplicarCaracterizacion/);
  assert.match(rutas, /caracterizaciones_poblacion_auditoria/);
  assert.match(rutas, /await obtenerAnioActivo\(\)/);
});

test("solo Orientación y Administración acceden y la orientadora se limita a sus secciones", () => {
  assert.match(rutas, /u\?\.rol==="admin" \|\| u\?\.rol==="orientador"/);
  assert.match(rutas, /requireCaracterizacion/);
  assert.match(rutas, /seccion_orientador_anio[\s\S]*orientador_id=\$3/);
  assert.match(frontend, /if\(esAdmin\|\|esOrientador\)[\s\S]*nav-caracterizacion/);
  assert.doesNotMatch(frontend, /if\(esAdmin\|\|esAuxiliar\)[^{]*\{[\s\S]{0,180}nav-caracterizacion/);
});

test("la interfaz ofrece consulta individual, matriz grupal y vínculo con Alerta Temprana", () => {
  assert.match(frontend, /Vista individual/);
  assert.match(frontend, /Matriz grupal/);
  assert.match(frontend, /class="car-matrix"/);
  assert.match(frontend, /carGuardarIndividual/);
  assert.match(frontend, /carGuardarMatriz/);
  assert.match(rutas, /caracterizacion\/estudiantes\/:[^"/]+/);
  assert.match(rutas, /caracterizacion\/secciones\/:[^"/]+/);
  assert.match(rutas, /puede_ver_caracterizacion/);
  assert.match(frontend, /carAbrirDesdeAlerta/);
});

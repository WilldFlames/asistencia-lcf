const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const raiz = path.join(__dirname,"..");
const leer = p => fs.readFileSync(path.join(raiz,p),"utf8");
const db = leer("db.js");
const matricula = leer("routes/matricula.js");
const estudiantes = leer("routes/estudiantes.js");
const frontend = leer("public/index.html");

test("las restricciones son anuales, bidireccionales y auditables", () => {
  assert.match(db,/CREATE TABLE IF NOT EXISTS restricciones_matricula/);
  assert.match(db,/CHECK \(estudiante_a_id < estudiante_b_id\)/);
  assert.match(db,/UNIQUE \(anio, estudiante_a_id, estudiante_b_id\)/);
  assert.match(db,/creada_por/);
  assert.match(db,/eliminada_por/);
  assert.match(matricula,/function normalizarPareja/);
  assert.match(matricula,/ON CONFLICT \(anio,estudiante_a_id,estudiante_b_id\)/);
});

test("matrícula bloquea ambos sentidos sin permitir forzado", () => {
  assert.match(matricula,/async function conflictosEnSeccion/);
  assert.match(matricula,/estudiante_a_id=\$1 OR estudiante_b_id=\$1/);
  assert.match(matricula,/El estudiante tiene una restricción de convivencia/);
  const validacion = matricula.indexOf("const incompatibles = await conflictosEnSeccion");
  const cupos = matricula.indexOf("Verificar cupos", validacion);
  assert.ok(validacion > 0 && cupos > validacion, "la restricción debe comprobarse antes de los cupos y del guardado");
});

test("el cierre anual se detiene si quedó una pareja en la misma sección", () => {
  assert.match(matricula,/conflictos_restricciones/);
  assert.match(matricula,/Última barrera antes de tocar datos históricos/);
  assert.match(matricula,/No se puede aplicar \$\{anio\}/);
});

test("los cambios manuales de sección también respetan la restricción", () => {
  assert.match(estudiantes,/validarRestriccionSeccionActual/);
  assert.match(estudiantes,/router\.put\("\/:id\/seccion"/);
  assert.match(estudiantes,/router\.put\("\/:id\/asignar-seccion"/);
  assert.match(estudiantes,/router\.post\("\/:id\/reactivar"/);
});

test("la interfaz permite buscar parejas y señala secciones incompatibles", () => {
  assert.match(frontend,/id="modal-restricciones-matricula"/);
  assert.match(frontend,/function rmFiltrar/);
  assert.match(frontend,/function rmGuardar/);
  assert.match(frontend,/🚫 RESTRICCIÓN/);
  assert.match(frontend,/id="asignar-restricciones-info"/);
});


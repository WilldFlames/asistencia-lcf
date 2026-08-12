const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const raiz = path.join(__dirname, "..");
const leer = archivo => fs.readFileSync(path.join(raiz, archivo), "utf8");

test("las citas tienen disponibilidad, estados y protección contra doble reserva", () => {
  const db = leer("db.js");
  assert.match(db, /CREATE TABLE IF NOT EXISTS citas_disponibilidad/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS citas \(/);
  assert.match(db, /pendiente_de\s+TEXT CHECK/);
  assert.match(db, /citas_profesor_hora_activa_uq/);
});

test("el portal limita citas y datos al hijo del encargado autenticado", () => {
  const padres = leer("routes/padres.js");
  assert.match(padres, /router\.get\("\/hijo\/:id\/citas", requirePadre, hijoDelPadre/);
  assert.match(padres, /router\.post\("\/hijo\/:id\/citas", requirePadre, hijoDelPadre/);
  assert.match(padres, /encargado_cedula=\$2/);
  assert.match(padres, /docenteDelHijo\(req\.hijo/);
  assert.match(padres, /validarSlotProfesor/);
});

test("la vista del encargado conserva todos los módulos y agrega jornada diaria", () => {
  const html = leer("public/index.html");
  for (const tab of ["inicio","asistencia","conducta","avisos","porteria","permisos","horario","citas"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
  }
  assert.match(html, /asistencia-dia\?fecha=/);
  assert.match(html, /ppCargarPermisos/);
  assert.match(html, /ppCargarCitas/);
});

test("el docente puede publicar horas y responder solicitudes", () => {
  const rutas = leer("routes/citas.js");
  const html = leer("public/index.html");
  assert.match(rutas, /router\.put\("\/disponibilidad", requireDocente/);
  assert.match(rutas, /router\.put\("\/:id\/responder", requireDocente/);
  assert.match(rutas, /pendiente_de='encargado'/);
  assert.match(html, /id="nav-citas"/);
  assert.match(html, /function citasDocAbrirRespuesta/);
});

test("el docente puede buscar estudiantes por nombre, cédula, sección o materia", () => {
  const html = leer("public/index.html");
  assert.match(html,/id="cita-doc-buscar"/);
  assert.match(html,/function citasFiltrarEstudiantes/);
  assert.match(html,/nombrePersona\(e\).*e\.cedula.*e\.seccion_nombre.*e\.materias/);
  assert.match(html,/terminos\.every\(t=>texto\.includes\(t\)\)/);
  assert.match(html,/lista\.length===1.*seleccionado automáticamente/);
});

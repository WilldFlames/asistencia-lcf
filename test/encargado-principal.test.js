const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const matricula = fs.readFileSync(path.join(root, "routes", "matricula.js"), "utf8");
const encargados = fs.readFileSync(path.join(root, "routes", "encargados.js"), "utf8");
const padres = fs.readFileSync(path.join(root, "routes", "padres.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "routes", "admin.js"), "utf8");
const push = fs.readFileSync(path.join(root, "utils", "push-familias.js"), "utf8");
const db = fs.readFileSync(path.join(root, "db.js"), "utf8");

test("matrícula obliga a escoger un único encargado principal", () => {
  assert.match(html, /name="mat-encargado-principal"/);
  assert.match(html, /principales\.length!==1/);
  assert.match(html, /El encargado principal debe tener cédula, nombre y primer apellido/);
  assert.match(matricula, /principales\.length !== 1/);
  assert.match(matricula, /e\.es_principal===true/);
});

test("la base de datos impide dos principales para el mismo estudiante", () => {
  assert.match(db, /encargados_un_principal_por_estudiante/);
  assert.match(db, /WHERE es_principal=true/);
  assert.match(db, /ROW_NUMBER\(\) OVER/);
});

test("el principal se puede cambiar y no se pierde al eliminar", () => {
  assert.match(encargados, /router\.put\("\/:id\/principal"/);
  assert.match(encargados, /No se puede eliminar el único encargado/);
  assert.match(encargados, /UPDATE encargados SET es_principal=true[\s\S]*SELECT id FROM encargados/);
  assert.match(html, /Hacer principal/);
});

test("solo el principal obtiene portal y notificaciones familiares", () => {
  assert.match(padres, /COALESCE\(enc\.es_principal,false\) = true/);
  assert.match(padres, /no está designada como encargado principal/);
  assert.match(admin, /Solo el encargado principal puede tener acceso al portal familiar/);
  assert.match(push, /COALESCE\(enc\.es_principal,false\)=true/);
});

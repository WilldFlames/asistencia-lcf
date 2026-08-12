const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "routes", "debidosProcesos.js"),
  "utf8"
);

test("todas las rutas de un proceso concreto aplican requireProcesoAccess", () => {
  const declarations = source.match(/router\.(?:get|post|put|delete)\("\/:id[^\n]+/g) || [];
  assert.ok(declarations.length >= 16, "se esperaban todas las rutas sensibles de Debidos Procesos");
  for (const declaration of declarations) {
    assert.match(declaration, /requireAuth, requireProcesoAccess,/);
  }
});

test("no se conservan las credenciales administrativas conocidas", () => {
  const db = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(db, /Admin2024\*\*|VALUES \('0000000000'/);
  assert.doesNotMatch(server, /Admin2024\*\*|0000000000/);
});

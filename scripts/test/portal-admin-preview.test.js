const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const admin = fs.readFileSync(path.join(root, "routes", "admin.js"), "utf8");
const padres = fs.readFileSync(path.join(root, "routes", "padres.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

test("solo un administrador puede iniciar la vista de prueba de una familia", () => {
  assert.match(admin, /router\.post\("\/padres\/:cedula\/vista-prueba", onlyAdmin/);
  assert.match(admin, /modo_prueba:\s*true/);
  assert.match(admin, /administrador_id:\s*req\.session\.usuario\.id/);
  assert.match(admin, /await saveSession\(req\)/);
  assert.doesNotMatch(admin, /vista-prueba[\s\S]{0,1500}(password_hash|bcrypt\.hash)/);
});

test("la vista de prueba conserva la sesión administrativa y es de solo lectura", () => {
  assert.match(padres, /if\(p\.modo_prueba\)/);
  assert.match(padres, /req\.session\?\.usuario\?\.rol !== "admin"/);
  assert.match(padres, /req\.method !== "GET"/);
  assert.match(padres, /La vista de prueba es de solo lectura/);
  assert.match(padres, /delete req\.session\.padre;\s*await saveSession\(req\);\s*return res\.json\(\{ ok:true, modo_prueba:true \}\)/);
});

test("el administrador puede abrir y reconocer claramente el portal de prueba", () => {
  assert.match(html, /onclick="gpProbarPortal\('\$\{p\.cedula\}'\)"/);
  assert.match(html, /👁 Probar portal/);
  assert.match(html, /id="pp-preview-banner"/);
  assert.match(html, /Vista de prueba del administrador/);
  assert.match(html, /p\.modo_prueba \? "Volver al sistema" : "Salir"/);
  assert.match(html, /vista\.padre\?\.modo_prueba/);
});

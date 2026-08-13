const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const leer = archivo => fs.readFileSync(path.join(root, archivo), "utf8");

test("Personal LCF tiene una entrada instalable independiente", () => {
  const manifest = JSON.parse(leer("public/personal.webmanifest"));
  assert.equal(manifest.id, "/personal");
  assert.equal(manifest.name, "Personal LCF");
  assert.equal(manifest.start_url, "/personal?app=personal");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some(icon => icon.sizes === "512x512" && icon.purpose === "maskable"));
  for (const icon of manifest.icons) {
    const archivo = path.join(root, "public", icon.src.replace(/^\//, ""));
    assert.ok(fs.existsSync(archivo), `${icon.src} debe existir`);
  }
});

test("la entrada Personal cambia metadatos sin duplicar el sistema", () => {
  const server = leer("server.js");
  assert.match(server, /app\.get\(\["\/personal","\/personal\/"\]/);
  assert.match(server, /personal\.webmanifest/);
  assert.match(server, /personal-lcf-180\.png/);
  assert.match(server, /fs\.readFileSync\(path\.join\(__dirname,"public","index\.html"/);
  assert.doesNotMatch(server, /personal-index\.html/);
});

test("la app del personal conserva permisos y navegación del sistema", () => {
  const html = leer("public/index.html");
  const pwa = leer("public/pwa.js");
  assert.match(html, /id="personal-pwa-panel"/);
  assert.match(html, /href="\/personal\?app=personal"/);
  assert.match(pwa, /function iniciarPersonal\(/);
  assert.match(pwa, /function abrirDestinoPersonal\(/);
  assert.match(pwa, /typeof goTo !== "function"/);
  assert.doesNotMatch(pwa, /ME\.rol\s*=/);
});

test("las notificaciones del personal se entregan aun con la app cerrada", () => {
  const db = leer("db.js");
  const rutas = leer("routes/notificaciones.js");
  const worker = leer("utils/push-personal.js");
  const sw = leer("public/sw.js");
  const server = leer("server.js");
  assert.match(db, /CREATE TABLE IF NOT EXISTS push_suscripciones_personal/);
  assert.match(rutas, /router\.post\("\/push\/suscribir", requireAuth/);
  assert.match(worker, /id>\$2/);
  assert.match(worker, /webpush\.sendNotification/);
  assert.match(server, /setInterval\(\(\)=>procesarNotificacionesPersonal/);
  assert.match(sw, /datos\.app === "personal"/);
  assert.match(sw, /LCF_OPEN_NOTIFICATION/);
  assert.match(sw, /destinoPersonal/);
});

test("Personal LCF no guarda datos privados para funcionar sin conexión", () => {
  const sw = leer("public/sw.js");
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(sw, /event\.respondWith\(fetch\(request\)\)/);
  assert.doesNotMatch(sw, /caches\.put\([^\n]*\/api\//);
});

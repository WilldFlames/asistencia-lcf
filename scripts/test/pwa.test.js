const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");

test("el portal publica una PWA de familias con entrada propia", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.name, "LCF Familias");
  assert.equal(manifest.start_url, "/?app=familias");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#08243d");
  assert.ok(manifest.icons.some(icon => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some(icon => icon.sizes === "512x512" && icon.purpose === "maskable"));
});

test("todos los iconos declarados existen y contienen las dimensiones correctas", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8"));
  for (const icon of manifest.icons) {
    const file = path.join(publicDir, icon.src.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), `${icon.src} debe existir`);
    const png = fs.readFileSync(file);
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    const [expectedWidth, expectedHeight] = icon.sizes.split("x").map(Number);
    assert.equal(png.readUInt32BE(16), expectedWidth);
    assert.equal(png.readUInt32BE(20), expectedHeight);
  }
});

test("el service worker nunca almacena respuestas privadas de la API", () => {
  const sw = fs.readFileSync(path.join(publicDir, "sw.js"), "utf8");
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(sw, /event\.respondWith\(fetch\(request\)\)/);
  assert.doesNotMatch(sw, /caches\.put\([^\n]*\/api\//);
});

test("la página carga el manifiesto, los recursos PWA y el acceso de instalación", () => {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /id="pwa-install-btn"/);
  assert.match(html, /src="\/pwa\.js"/);
  assert.match(html, /LCFPWA\?\.mostrarInstalacionPadres\(\)/);
});

test("la pantalla sin conexión no incluye información de estudiantes", () => {
  const html = fs.readFileSync(path.join(publicDir, "offline.html"), "utf8");
  assert.match(html, /no guarda en el teléfono la información privada/);
  assert.doesNotMatch(html, /api\/padres|sessionStorage|localStorage/);
});

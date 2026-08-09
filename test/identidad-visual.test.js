const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const frontend = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("la identidad visual está aislada de los documentos impresos", () => {
  assert.match(frontend, /IDENTIDAD VISUAL INSTITUCIONAL 2026/);
  assert.match(frontend, /@media screen \{/);
  assert.match(frontend, /@media print\{/);
  assert.match(frontend, /class="sidebar-brand"/);
  assert.match(frontend, /id="sidebar-shield"/);
  assert.match(frontend, /function iniciarIdentidadVisual\(\)/);
});

test("la renovación conserva el inventario de controles y módulos", () => {
  const botones = frontend.match(/<button\b/gi) || [];
  const paginas = frontend.match(/class="page(?:\s|\")/gi) || [];
  // El archivo original tenía dos botones idénticos de "Promedio" con el
  // mismo id. La identidad conserva uno funcional y elimina solo el duplicado.
  assert.ok(botones.length >= 482, `Se esperaban al menos 482 botones únicos/funcionales y hay ${botones.length}`);
  assert.ok(paginas.length >= 36, `Se esperaban al menos 36 páginas navegables y hay ${paginas.length}`);

  const modulosEsenciales = [
    "dashboard", "asistencia", "calificaciones", "conducta", "horario",
    "estudiantes", "reportes", "prematricula", "matricula", "usuarios",
    "asignaciones", "debidos", "protocolos", "inventario"
  ];
  for (const modulo of modulosEsenciales) {
    assert.match(frontend, new RegExp(`data-page="${modulo}"`));
    assert.match(frontend, new RegExp(`id="page-${modulo}"`));
  }
});

test("los accesos continúan dependiendo del perfil y las funciones extra", () => {
  assert.match(frontend, /ME\.funciones_extra && ME\.funciones_extra\.includes\(rol\)/);
  assert.match(frontend, /if\(esProfesor\|\|esGuia\|\|esOrientador\)/);
  assert.match(frontend, /if\(esAdmin\|\|esAuxiliar\|\|esAdminIst\)/);
  assert.match(frontend, /window\.esComiteMatricula = true/);
  assert.match(frontend, /document\.getElementById\("nav-matricula"\)\.style\.display=""/);
  assert.match(frontend, /function actualizarEncabezadoPagina\(page\)/);
});

test("la interfaz se adapta a iPhone, áreas seguras y navegador móvil", () => {
  const html = frontend;
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /height:100dvh/);
  assert.match(html, /env\(safe-area-inset-top\)/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
  assert.match(html, /hover:none\) and \(pointer:coarse/);
  assert.match(html, /input,select,textarea\{font-size:16px!important/);
  assert.match(html, /window\.innerWidth<=1024/);
  assert.match(html, /max-width:1024px\) and \(max-height:600px/);
  assert.match(html, /fullscreen\.show\{align-items:flex-start;justify-content:center;overflow-y:auto/);
});

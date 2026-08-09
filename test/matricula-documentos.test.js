const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const frontend = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("los cinco documentos de matricula usan el generador PDF MEP", () => {
  const llamadasEsperadas = [
    'imprimirPDFMEP("FICHA DE MATRÍCULA 2027"',
    'imprimirPDFMEP("DECLARACIÓN DE COMPROMISO DE MATRÍCULA · PERIODO LECTIVO 2027"',
    'imprimirPDFMEP("AUTORIZACIÓN PARA EL USO DE IMAGEN"',
    'imprimirPDFMEP("FORMULARIO PARA SOLICITUD DE BECA DE COMEDOR 2027"',
    'imprimirPDFMEP("SOLICITUD DE VALORACIÓN DE ADECUACIÓN CURRICULAR"',
  ];

  for (const llamada of llamadasEsperadas) {
    assert.ok(frontend.includes(llamada), `Falta migrar: ${llamada}`);
  }
});

test("la autorizacion de imagen esta disponible en el asistente", () => {
  assert.match(frontend, /Autorización de Uso de Imagen/);
  assert.match(frontend, /onclick="imprimirAutorizacionImagenFuera\(\)"/);
});

test("los modales no se cierran al hacer clic en el fondo", () => {
  assert.doesNotMatch(frontend, /if\s*\(\s*e\.target\s*===\s*o\s*\)\s*o\.classList\.remove\(["']show["']\)/);
  assert.match(frontend, /function cerrarModal\(id\)/);
});

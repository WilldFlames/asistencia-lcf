const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const frontend = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const backend = fs.readFileSync(path.join(__dirname, "..", "routes", "debidosProcesos.js"), "utf8");

test("las citas identifican ofendido, ofensor y testigo", () => {
  assert.match(frontend, /BOLETA DE CITA · SUPUESTO\(A\) OFENDIDO\(A\)/);
  assert.match(frontend, /BOLETA DE CITA · SUPUESTO\(A\) OFENSOR\(A\)/);
  assert.match(frontend, /BOLETA DE CITA · TESTIGO/);
  assert.doesNotMatch(frontend, /BOLETA DE CITA ENCARGADO LEGAL/);
});

test("la cita no imprime el tipo de falta investigada", () => {
  assert.match(frontend, /supuesta comisión de una falta por parte de una persona estudiante/);
  assert.doesNotMatch(frontend, /posible comisión de la falta <strong>\$\{tipoF\}/);
  assert.doesNotMatch(frontend, /id="dpp-tipo_falta"/);
});

test("los documentos distinguen profesor asignado y profesor guia", () => {
  assert.match(frontend, /Profesor\(a\) asignado\(a\)' : 'Profesor\(a\) guía/);
  assert.match(frontend, /reg\.asig_cedula/);
  assert.match(backend, /u3\.cedula AS asig_cedula/);
});

test("traslado y resolucion heredan descripcion y puntos oficiales", () => {
  assert.match(frontend, /async function cargarFaltaYConsecuenciasREAC\(grupo\)/);
  assert.match(frontend, /x\.categoria==='rebajo_puntos' && x\.gravedad===faltaBase\?\.gravedad/);
  assert.match(frontend, /puntos_rebajados: document\.getElementById\('dec-puntos-rebajados'\)\.value/);
  assert.match(frontend, /categoriaEsperada.*rebajo_puntos/s);
});

test("los documentos de debido proceso usan imprimirPDFMEP", () => {
  assert.match(frontend, /imprimirPDFMEP\('PORTADA DEL EXPEDIENTE'/);
  assert.match(frontend, /await imprimirPDFMEP\(tituloOficial, contenidoHTML, archivo\)/);
});

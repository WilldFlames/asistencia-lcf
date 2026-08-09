const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const frontend = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const estudiantes = fs.readFileSync(path.join(__dirname, "..", "routes", "estudiantes.js"), "utf8");

test("los informes heredados pasan por el generador PDF MEP", () => {
  assert.match(frontend, /async function imprimirConEncabezado\(area, styleEl, nombreArchivo\)/);
  assert.match(frontend, /await imprimirPDFMEP\(doc\.titulo \|\| null, doc\.contenidoHTML/);
  assert.match(frontend, /await imprimirConEncabezado\(\s*mount,/);
  assert.match(frontend, /informe_ausentismo_\$\{estudianteArchivo\}/);
});

test("asistencia, listas y cumplimiento tienen salida PDF oficial", () => {
  assert.match(frontend, /imprimirPDFMEP\("REPORTE DE ASISTENCIA"/);
  assert.match(frontend, /lista_estudiantes_\$\{archivoNivel\}/);
  assert.match(frontend, /id="btn-imprimir-cumplimiento"/);
  assert.match(frontend, /imprimirPDFMEP\("REPORTE ADMINISTRATIVO DE CUMPLIMIENTO"/);
});

test("archivar y reactivar mantienen una auditoria coherente", () => {
  assert.match(estudiantes, /retirado_por=\$3,[\s\S]*fecha_retiro=NOW\(\)/);
  assert.match(estudiantes, /retirado_por=NULL,[\s\S]*fecha_retiro=NULL/);
  assert.match(frontend, /Realizado por: <strong>/);
  assert.match(frontend, /fmtTS\(h\.fecha\)/);
});

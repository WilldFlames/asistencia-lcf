const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const raiz = path.join(__dirname, "..");
const leer = archivo => fs.readFileSync(path.join(raiz, archivo), "utf8");
const alertas = leer("routes/alertaTemprana.js");
const asistencia = leer("routes/asistencia.js");
const frontend = leer("public/index.html");

test("el PDF del expediente inicia con portada y separa la información por materia", () => {
  assert.match(alertas, /expediente_materias\s*:\s*materias\.rows/);
  assert.match(alertas, /at\.estudiante_id=\$1 AND at\.anio=\$2/);
  assert.match(frontend, /Materias incorporadas:<\/strong>\s*\$\{materias\.length\}/);
  assert.match(frontend, /pdf-page-block at-pdf/);
  assert.match(frontend, /Plan y contactos/);
  assert.match(frontend, /text-align:justify/);
  assert.match(frontend, /imprimirPDFMEP\("EXPEDIENTE DE ALERTA TEMPRANA",portada\+paginas\.join\(''\),nombre,\{bloquesPagina:true\}\)/);
  assert.doesNotMatch(frontend, /imprimirPDFMEP\(html,'Alerta Temprana'\)/);
});

test("Fortalecimiento Matemático genera boleta solo desde el 12 de octubre de 2026", () => {
  assert.match(asistencia, /INICIO_BOLETA_FORTALECIMIENTO_MATEMATICO\s*=\s*"2026-10-12"/);
  assert.match(asistencia, /m\.nombre ILIKE '%fortalecimiento%matem%'/);
  assert.match(asistencia, /String\(fecha\) >= INICIO_BOLETA_FORTALECIMIENTO_MATEMATICO/);
  assert.match(asistencia, /asignacionBoleta\?\.es_guia_ori \|\| aplicaFortalecimiento/);
  assert.match(asistencia, /Boleta generada automáticamente por ausencia injustificada en \$\{materiaBoleta\}/);
  assert.match(asistencia, /DELETE FROM boletas_conducta WHERE id=\$1/);
});

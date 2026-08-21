const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const frontend = read("public/index.html");
const backend = read("routes/debidosProcesos.js");
const db = read("db.js");

test("conciliación conserva solicitud, aprobación, participante e historial", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS dp_conciliaciones/);
  assert.match(db, /estudiante_b_id\s+INTEGER REFERENCES estudiantes/);
  assert.match(db, /solicitado_por[\s\S]+decidido_por[\s\S]+cerrado_por/);
  assert.match(db, /uq_dpconc_activa[\s\S]+estado IN \('pendiente','aprobada'\)/);

  assert.match(backend, /"\/:id\/conciliacion\/solicitar"/);
  assert.match(backend, /"\/:id\/conciliacion\/decidir"/);
  assert.match(backend, /"\/:id\/conciliacion\/cerrar"/);
  assert.match(backend, /Solo el orientador asignado puede decidir la conciliación/);
  assert.match(backend, /estado='conciliado'/);
});

test("los documentos de conciliación solo se habilitan con aprobación", () => {
  assert.match(backend, /\["conciliacion_autorizacion", "conciliacion_carta"\]\.includes\(tipo\)/);
  assert.match(backend, /\["aprobada", "cerrada"\]\.includes\(concR\.rows\[0\]\.estado\)/);
  assert.match(backend, /conciliacion_autorizacion_1[\s\S]+conciliacion_autorizacion_2[\s\S]+conciliacion_carta_1/);
  assert.match(frontend, /Autorización familiar para conciliación/);
  assert.match(frontend, /Carta de conciliación entre estudiantes/);
  assert.match(frontend, /autorizacion_conciliacion_estudiante_\$\{orden\}/);
});

test("los formularios oficiales autorrellenan estudiantes, secciones y responsables", () => {
  assert.match(frontend, /dpConciliacionPartes\(\)/);
  assert.match(frontend, /encargado_nombre:encA\.nombre_completo/);
  assert.match(frontend, /Nombre del estudiante[\s\S]+participante\.seccion_nombre/);
  assert.match(frontend, /Responsable legal A[\s\S]+Responsable legal B/);
  assert.match(frontend, /AUTORIZACIÓN FAMILIAR PARA CONCILIACIÓN/);
  assert.match(frontend, /CARTA DE CONCILIACIÓN ENTRE ESTUDIANTES/);
  assert.match(frontend, /await imprimirPDFMEP\(tituloOficial, contenidoHTML, archivo\)/);
});

test("el proceso protege participantes y exige todos los documentos para conciliar", () => {
  assert.match(backend, /No se pueden cambiar los participantes mientras la conciliación esté pendiente o aprobada/);
  assert.match(backend, /La sección no tiene un orientador asignado/);
  assert.match(backend, /Antes de cerrar, completá:/);
  assert.match(frontend, /Cerrar caso por conciliación/);
  assert.match(frontend, /dpCambiarTab\('conciliado'\)/);
});

test("la decisión se elige antes de la tipificación y desestimar usa solo el acta", () => {
  const decisionPos = frontend.indexOf('id="dec-decision"');
  const tipificacionPos = frontend.indexOf('id="dec-detalles-continuar"');
  assert.ok(decisionPos >= 0 && decisionPos < tipificacionPos);
  assert.match(frontend, /decision==='continuar'\?'':'none'/);
  assert.match(frontend, /Decisión de desestimar y justificación de la profesora guía/);
  assert.match(frontend, /min-height:330px/);
  assert.doesNotMatch(backend, /INSERT INTO dp_pasos[^;]+['"]desestima['"]/s);
  assert.match(backend, /El orientador debe aprobar el acta de sesión antes de cerrar/);
  assert.match(backend, /Completá el traslado de cargos y la resolución final antes de cerrar/);
});

test("Protocolos cambia de nombre visible a Pautas sin alterar sus rutas internas", () => {
  assert.match(frontend, /data-page="protocolos"[^>]*>[\s\S]*?<span>Pautas<\/span>/);
  assert.match(frontend, /<h2 style="margin:0;">🛡️ Pautas MEP<\/h2>/);
  assert.match(frontend, />\+ Nueva Pauta<\/button>/);
  assert.match(frontend, /api\('\/api\/protocolos'/);
});

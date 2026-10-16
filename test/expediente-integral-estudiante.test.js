const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const leer=f=>fs.readFileSync(path.join(root,f),'utf8');
const db=leer('db.js');
const ruta=leer('routes/expedienteIntegral.js');
const server=leer('server.js');
const ui=leer('public/index.html');

test('el expediente integral es una compilación auditada sin alterar documentos fuente',()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS expediente_integral_generaciones/);
  assert.match(db,/entidad_solicitante\s+TEXT NOT NULL/);
  assert.match(db,/motivo\s+TEXT NOT NULL/);
  assert.match(db,/incluye_confidenciales BOOLEAN NOT NULL DEFAULT false/);
  assert.match(ruta,/INSERT INTO expediente_integral_generaciones/);
  assert.doesNotMatch(ruta,/UPDATE\s+(debidos_procesos|protocolos|minutas|alertas_tempranas)/i);
});

test('Administración consulta toda la institución y Orientación solo sus niveles actuales',()=>{
  assert.match(ruta,/Este apartado es exclusivo de Administración y Orientación/);
  assert.match(ruta,/seccion_orientador_anio soa/);
  assert.match(ruta,/NOT EXISTS \(SELECT 1 FROM seccion_orientador_anio soa_any/);
  assert.match(ruta,/estudiantePermitido/);
  assert.match(ruta,/orientadorResponsable/);
});

test('la información confidencial se excluye por defecto y exige confirmación expresa',()=>{
  assert.match(ruta,/const incluirConfidenciales=req\.body\.incluir_confidenciales===true/);
  assert.match(ruta,/incluirConfidenciales \? pool\.query/);
  assert.match(ruta,/m\.es_confidencial=true/);
  assert.match(ui,/Este PDF incluirá documentación confidencial de Orientación/);
  assert.match(ui,/Su inclusión quedará registrada/);
});

test('la interfaz genera portada índice y secciones identificadas en el PDF institucional',()=>{
  assert.match(server,/\/api\/expediente-integral/);
  assert.match(ui,/id="page-expediente-integral"/);
  assert.match(ui,/EXPEDIENTE INTEGRAL DEL ESTUDIANTE/);
  assert.match(ui,/Índice documental/);
  assert.match(ui,/Debidos procesos/);
  assert.match(ui,/Alertas tempranas/);
  assert.match(ui,/Movimientos de Portería/);
  assert.match(ui,/imprimirPDFMEP\(null,pdf\.html,pdf\.archivo,\{bloquesPagina:true\}\)/);
});

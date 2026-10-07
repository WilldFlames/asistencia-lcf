const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const read=f=>fs.readFileSync(path.join(root,f),"utf8");
const db=read("db.js"),routes=read("routes/expedientesConducta.js"),front=read("public/index.html"),dp=read("routes/debidosProcesos.js");

test("expedientes de conducta conserva consecutivo, siete pasos y cierre auditable",()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS expedientes_conducta_tes/);
  assert.match(db,/UNIQUE\(anio,numero\)/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS expedientes_conducta_pasos/);
  assert.match(db,/paso INTEGER NOT NULL CHECK\(paso BETWEEN 1 AND 7\)/);
  assert.match(routes,/pg_advisory_xact_lock/);
  assert.match(routes,/generate_series\(1,7\)/);
  assert.match(routes,/Solo administración puede reabrir un expediente cerrado/);
});

test("el profesor guía ve aplazados de sus secciones y el comité aprueba individualmente",()=>{
  assert.match(routes,/seccion_guia_anio/);
  assert.match(routes,/ROUND\(\(n\.nota_i\+n\.nota_ii\)\/2\.0,1\)/);
  assert.match(routes,/tipoComiteActivo/);
  assert.match(routes,/"comite_evaluacion" : "comite_tecnico_asesor"/);
  assert.match(db,/UNIQUE\(expediente_id,usuario_id\)/);
  assert.match(routes,/requiere la aprobación individual de los tres miembros/);
  assert.match(front,/Asignar Comité de Evaluación \(3\)/);
});

test("el flujo guarda e imprime todos los pasos en formato institucional",()=>{
  assert.match(front,/const ECT_PASOS=\[/);
  assert.match(front,/Notificación de condición aplazada/);
  assert.match(front,/Verificación de acciones correctivas/);
  assert.match(front,/Anexo 1 · Diseño e instrumento de evaluación/);
  assert.match(front,/Anexo 3 · Resultado final/);
  assert.match(front,/Portada Expediente de Conducta/);
  assert.doesNotMatch(front,/EXPEDIENTE DE MATRÍCULA/);
  assert.match(front,/await imprimirPDFMEP\(titulo\.toLocaleUpperCase/);
});

test("inasistencia y condición académica se remiten sin reprobar automáticamente",()=>{
  assert.match(routes,/No se cierra automáticamente/);
  assert.match(routes,/\["inasistencia","condicion_academica"\]/);
  assert.match(front,/no constituye por sí solo una decisión final/);
  assert.match(front,/no impide por sí sola la continuidad del TES/);
  assert.match(routes,/cerrado_accion_pendiente/);
});

test("Conducta usa la nota definitiva del TES sin borrar boletas ni períodos",()=>{
  assert.match(front,/resultado-tes\?anio=/);
  assert.match(front,/Resultado definitivo por TES/);
  assert.match(routes,/nota_final_conducta=CASE WHEN \$2='aprobado'/);
  assert.match(read("routes/conducta.js"),/resultado-tes/);
});

test("desestimar cierra, imprime y permite reimprimir la carta independiente",()=>{
  assert.match(front,/cerrarEImprimirDesestimaDP/);
  assert.match(front,/imprimirCartaDesestimaDP/);
  assert.match(front,/Reimprimir carta de desestima/);
  assert.match(front,/DESESTIMA DEL PROCESO/);
  assert.match(dp,/nuevoEstado = "desestimado"/);
});

test("la minuta refresca su contenido antes de imprimir",()=>{
  assert.match(front,/minActual\.minuta\.temas_tratados=temas_tratados/);
  assert.match(front,/minActual=await api\(`\/api\/minutas\/\$\{minActual\.minuta\.id\}`\)/);
});

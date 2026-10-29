const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const read=f=>fs.readFileSync(path.join(root,f),"utf8");
const db=read("db.js"),routes=read("routes/expedientesConducta.js"),front=read("public/index.html"),dp=read("routes/debidosProcesos.js");
const sincronizacion=read("utils/sincronizar-expediente-conducta.js"),conducta=read("routes/conducta.js");

test("expedientes de conducta conserva consecutivo, siete pasos y cierre auditable",()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS expedientes_conducta_tes/);
  assert.match(db,/UNIQUE\(anio,numero\)/);
  assert.match(db,/CREATE TABLE IF NOT EXISTS expedientes_conducta_pasos/);
  assert.match(db,/paso INTEGER NOT NULL CHECK\(paso BETWEEN 1 AND 7\)/);
  assert.match(routes,/pg_advisory_xact_lock/);
  assert.match(routes,/generate_series\(1,7\)/);
  assert.match(routes,/Solo administración puede reabrir un expediente cerrado/);
});

test("el profesor guía ve aplazados y una aprobación del comité habilita el TES",()=>{
  assert.match(routes,/seccion_guia_anio/);
  assert.match(routes,/ROUND\(\(n\.nota_i\+n\.nota_ii\)\/2\.0,1\)/);
  assert.match(routes,/tipoComiteActivo/);
  assert.match(routes,/"comite_evaluacion" : "comite_tecnico_asesor"/);
  assert.match(db,/UNIQUE\(expediente_id,usuario_id\)/);
  assert.match(routes,/aprobación de al menos un miembro/);
  assert.match(routes,/a\.rows\[0\]\.n<1/);
  assert.match(routes,/ap\.rows\[0\]\.n<1/);
  assert.match(front,/Asignar Comité de Evaluación \(3\)/);
  assert.match(front,/se requiere 1/);
});

test("el comité puede revertir una aprobación sin borrar su trazabilidad",()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS expedientes_conducta_aprobaciones_historial/);
  assert.match(routes,/router\.post\("\/:id\/revertir-aprobacion"/);
  assert.match(routes,/Cada integrante solamente puede revertir su propia aprobación/);
  assert.match(routes,/paso>=4 AND completado=true/);
  assert.match(routes,/accion,ejecutado_por,motivo/);
  assert.match(front,/ectRevertirAprobacion/);
  assert.match(front,/La acción quedará registrada en el historial/);
});

test("volver del expediente reutiliza la lista y solo recalcula al actualizar",()=>{
  assert.match(front,/const ECT_LISTADO_CACHE_MS=60000/);
  assert.match(front,/function ectRenderListado\(d\)/);
  assert.match(front,/function ectActualizarFilaCache\(\)/);
  assert.match(front,/onclick="ectCargarListado\(true\)">↻ Actualizar/);
  assert.match(front,/if\(ectListadoActual&&ectListadoAnio===/);
  const volver=front.match(/function ectVolver\(\)\{[\s\S]*?\n\}/)?.[0]||"";
  assert.match(volver,/ectRenderListado\(ectListadoActual\)/);
  assert.doesNotMatch(volver,/ectCargarListado\(true\)/);
});

test("el guía o administración pueden corregir un cierre equivocado del paso 2",()=>{
  assert.match(routes,/router\.post\("\/:id\/revertir-paso-2"/);
  assert.match(routes,/Solo el docente guía asignado o administración/);
  assert.match(routes,/ec\.estado!=="cerrado_accion_pendiente"/);
  assert.match(routes,/paso>=3 AND completado=true/);
  assert.match(routes,/Corrección del Paso 2:/);
  assert.match(routes,/WHERE expediente_id=\$1 AND paso=2/);
  assert.match(front,/Corregir revisión del Paso 2/);
  assert.match(front,/function ectRevertirPaso2\(\)/);
  assert.match(front,/la información ya escrita no se borrará/);
});

test("el flujo guarda e imprime todos los pasos en formato institucional",()=>{
  assert.match(front,/const ECT_PASOS=\[/);
  assert.match(front,/Notificación de condición aplazada en conducta/);
  assert.match(front,/Constancia de verificación para acceso al TES/);
  assert.match(front,/Anexo 1 · Proyecto e instrumento de evaluación/);
  assert.match(front,/Anexo 3 · Comunicación de finalización y resultado del TES/);
  assert.match(front,/Anexo 4 · Acta de comunicación de la condición final en conducta/);
  assert.match(front,/Portada Expediente de Conducta/);
  assert.doesNotMatch(front,/EXPEDIENTE DE MATRÍCULA/);
  assert.match(front,/Trabajo con enfoque socioeducativo/);
  assert.match(front,/folio:`TES-/);
  assert.match(front,/artículo 146/);
  assert.match(front,/await imprimirPDFMEP\(titulo\.toLocaleUpperCase/);
  assert.match(front,/\{bloquesPagina:true\}/);
  assert.match(front,/class="pdf-page-block"/);
});

test("los botones conservan borradores sin romper pasos ya completados",()=>{
  assert.match(routes,/if\(completado && paso>1\)/);
  assert.match(routes,/paso===3 && completado && !PROYECTOS\.includes/);
  assert.match(routes,/completado=\(expedientes_conducta_pasos\.completado OR \$2\)/);
  assert.match(routes,/completado_en=CASE WHEN \$2 AND NOT expedientes_conducta_pasos\.completado/);
  assert.match(front,/ectGuardarPaso\(\$\{n\},false,this\)/);
  assert.match(front,/Guardar cambios/);
  assert.match(front,/btn\.textContent="⏳ Guardando\.\.\."/);
});

test("cada modalidad TES conserva actividades, seguridad e indicadores propios",()=>{
  assert.match(front,/Proyecto de reparación comunitaria/);
  assert.match(front,/Diagnóstico de convivencia/);
  assert.match(front,/Plan de reparación simbólica/);
  assert.match(front,/Proyecto de aseo comunitario/);
  assert.match(front,/Observación guiada/);
  assert.match(front,/Plan de cuidado seguro/);
  assert.match(front,/Proyecto de aprendizaje servicio/);
  assert.match(front,/Diagnóstico visual de bienes comunes/);
  assert.match(front,/Distribución segura de roles/);
  assert.match(front,/Puntuación obtenida/);
  assert.match(front,/Calificación TES/);
});

test("la constancia identifica debidos procesos y acciones aunque estén en pasos distintos",()=>{
  assert.match(routes,/procedimientos_debidos/);
  assert.match(routes,/NULLIF\(r\.contenido->>'desc_accion'/);
  assert.match(routes,/NULLIF\(t\.contenido->>'desc_accion'/);
  assert.match(routes,/NULLIF\(a\.contenido->>'desc_accion'/);
  assert.doesNotMatch(routes,/dp\.estado IN \('resuelto','archivado'\)/);
  assert.match(front,/N\.° \$\{a\.numero\}-\$\{a\.anio\}/);
  assert.match(front,/Constancia sin acciones correctivas/);
});

test("la notificación selecciona un encargado real del estudiante y conserva su identidad",()=>{
  assert.match(routes,/FROM encargados WHERE estudiante_id=\$1/);
  assert.match(routes,/WHERE id=\$1 AND estudiante_id=\$2/);
  assert.match(routes,/contenido\.encargado_id=Number\(x\.id\)/);
  assert.match(routes,/contenido\.recibe=\[x\.nombre,x\.primer_apellido,x\.segundo_apellido\]/);
  assert.match(front,/function ectSelectorEncargado/);
  assert.match(front,/Datos tomados del expediente institucional del estudiante/);
  assert.match(front,/encargado_id:encargadoId/);
  assert.doesNotMatch(front,/ectCampo\(`ect-1-recibe`,"Persona encargada que recibe"/);
});

test("la persona estudiante mayor de edad recibe y firma directamente todos los anexos",()=>{
  assert.match(routes,/e\.fecha_nacimiento <= CURRENT_DATE - INTERVAL '18 years'/);
  assert.match(routes,/if\(\[1,5,6\]\.includes\(paso\) && ec\.es_mayor_edad\)/);
  assert.match(routes,/contenido\.parentesco="Estudiante mayor de edad"/);
  assert.match(front,/function ectEsMayorEdad/);
  assert.match(front,/Las comunicaciones, constancias de recibido y firmas del TES corresponden directamente a la persona estudiante/);
  assert.match(front,/☑ estudiante mayor de edad/);
  assert.match(front,/Persona estudiante mayor de edad/);
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

test("cualquier cambio de nota invalida solo el expediente abierto y libera su consecutivo",()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS expedientes_conducta_cancelados/);
  assert.match(db,/expediente_snapshot JSONB/);
  assert.match(sincronizacion,/WHERE estudiante_id=\$1 AND anio=\$2 AND estado='en_curso'/);
  assert.match(sincronizacion,/INSERT INTO expedientes_conducta_cancelados/);
  assert.match(sincronizacion,/Math\.abs\(notaExpediente - nota\.nota_anual\)/);
  assert.match(sincronizacion,/la nota anual cambió de/);
  assert.match(sincronizacion,/DELETE FROM expedientes_conducta_tes\s+WHERE id=\$1 AND estado='en_curso'/);
  assert.match(routes,/sincronizarExpedientesConductaAbiertos\(anio\)/);
  assert.match(routes,/generate_series\(1,/);
  assert.doesNotMatch(routes,/COALESCE\(MAX\(numero\),0\)\+1 AS numero/);
});

test("agregar o retirar una boleta revalida inmediatamente el expediente en curso",()=>{
  assert.match(conducta,/sincronizarExpedienteConductaAbierto\(estudiante_id,anioBoleta\)/);
  assert.match(conducta,/DELETE FROM boletas_conducta WHERE id=\$1 RETURNING estudiante_id,fecha::text/);
  assert.match(conducta,/sincronizarExpedienteConductaAbierto\(x\.estudiante_id,anioBoleta\)/);
  assert.match(routes,/notaActual\.nota_anual>=notaActual\.minimo/);
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

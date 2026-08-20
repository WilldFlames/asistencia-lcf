const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const raiz=path.join(__dirname,"..");
const leer=f=>fs.readFileSync(path.join(raiz,f),"utf8");
const frontend=leer("public/index.html");
const matricula=leer("routes/matricula.js");
const alerta=leer("routes/alertaTemprana.js");
const calificaciones=leer("routes/calificaciones.js");
const db=leer("db.js");

test("matrícula guarda un borrador enlazado y permite regresar entre pasos",()=>{
  assert.match(frontend,/const r=await api\("\/api\/matricula\/guardar","POST",\{\.\.\.matDatosGuardados,anio:matAnio\}\)/);
  assert.match(frontend,/function matIrPaso\(n\)/);
  assert.match(frontend,/onclick="matPaso\(1\)"/);
  assert.match(frontend,/onclick="matPaso\(2\)"/);
  assert.match(frontend,/onclick="matPaso\(3\)"/);
  assert.match(matricula,/Guardar el paso 1 no equivale a/);
});

test("beca acepta montos completos y autorización completa fecha y funcionario",()=>{
  assert.match(frontend,/id="beca-ingreso" maxlength="12"/);
  assert.match(frontend,/id="beca-monto-avancemos" maxlength="12"/);
  assert.match(frontend,/const fechaDocumento=fmtF\(fechaHoyCR\(\)\)/);
  assert.match(frontend,/Tramitado por:<\/strong> \$\{funcionario\}/);
  assert.match(frontend,/iPad, etc\.\), debido a que no son solicitados/);
});

test("solicitud de matrícula llega pendiente al Comité de Apoyo al aplicar el año",()=>{
  assert.match(db,/solicitud_adecuacion ADD COLUMN IF NOT EXISTS anio_destino/);
  assert.match(db,/solicitudes_adecuacion_docente ADD COLUMN IF NOT EXISTS origen/);
  assert.match(matricula,/WHERE sa\.anio_destino=\$1 AND sa\.estado='guardada' AND m\.completada=true/);
  assert.match(matricula,/fi\.tipo='comite_apoyo'/);
  assert.doesNotMatch(matricula,/UPDATE estudiantes SET adecuacion='significativa' WHERE id=\$1/);
});

test("el borrado anual conserva una marca para que la matrícula no reaparezca",()=>{
  assert.match(matricula,/COALESCE\(ma\.estado,''\) <> 'eliminada'/);
  assert.match(matricula,/estado='eliminada'/);
  assert.match(matricula,/estado=CASE WHEN matricula\.estado='eliminada' THEN 'pendiente'/);
});

test("idioma y tecnología solo se seleccionan en décimo y se conservan en undécimo",()=>{
  assert.match(frontend,/parseInt\(nivel\)>=10 \? "" : "none"/);
  assert.match(frontend,/Undécimo conserva la elección de décimo/);
  assert.match(matricula,/const idiomaEf=nivelDestino>=10/);
  assert.match(matricula,/nivelDestino>=10 && secEsFrances !== estEsFrances/);
});

test("registro de llamadas ofrece los teléfonos del sistema y otro número",()=>{
  assert.match(alerta,/encargado_celular/);
  assert.match(alerta,/encargado_telefono_trabajo/);
  assert.match(frontend,/function atPoblarTelefonosLlamada/);
  assert.match(frontend,/Otro número…/);
  assert.match(frontend,/numeroSeleccionado==='__otro__'/);
});

test("cotidianos y tareas generan cuadros individuales derivados de las notas",()=>{
  assert.match(calificaciones,/router\.get\("\/resumen-rubro"/);
  assert.match(calificaciones,/FROM notas_indicador/);
  assert.match(frontend,/Resumen cotidianos/);
  assert.match(frontend,/Resumen tareas/);
  assert.match(frontend,/Este cuadro es de <strong>solo lectura<\/strong>/);
  assert.match(frontend,/function imprimirResumenRubro/);
});

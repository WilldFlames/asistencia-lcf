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
const admin=leer("routes/admin.js");

test("matrícula guarda un borrador enlazado y permite regresar entre pasos",()=>{
  assert.match(frontend,/const r=await api\("\/api\/matricula\/guardar","POST",\{\.\.\.matDatosGuardados,anio:matAnio\}\)/);
  assert.match(frontend,/function matIrPaso\(n\)/);
  assert.match(frontend,/onclick="matPaso\(1\)"/);
  assert.match(frontend,/onclick="matPaso\(2\)"/);
  assert.match(frontend,/onclick="matPaso\(3\)"/);
  assert.match(matricula,/Guardar el paso 1 no equivale a/);
});

test("guardar matrícula no confunde un fallo de impresión con un fallo de datos",()=>{
  assert.match(frontend,/Los datos sí quedaron guardados, pero no se pudo generar la ficha/);
  assert.match(frontend,/La solicitud sí quedó guardada, pero no se pudo generar el PDF/);
  assert.match(frontend,/Solicitud de beca guardada/);
  assert.match(frontend,/Solicitud de adecuación guardada/);
  assert.match(frontend,/if\(btn\?\.disabled\) return/);
});

test("los conteos de matrícula y cupos descuentan retirados y matrículas eliminadas",()=>{
  const expediente=leer("routes/expediente.js");
  assert.match(matricula,/COALESCE\(m\.estado,''\) <> 'eliminada'/);
  assert.match(matricula,/e\.activo=true AND COALESCE\(e\.archivado,false\)=false/);
  assert.match(matricula,/LEFT JOIN matricula m ON m\.seccion_id = s\.id AND m\.anio = \$1[\s\S]*EXISTS \(SELECT 1 FROM estudiantes e/);
  assert.match(matricula,/router\.get\("\/asignaciones\/:anio"[\s\S]*JOIN estudiantes e ON e\.id=m\.estudiante_id/);
  assert.match(matricula,/UPDATE estudiantes e SET[\s\S]*COALESCE\(m\.estado,''\) <> 'eliminada'/);
  assert.match(expediente,/COALESCE\(m\.estado,''\) <> 'eliminada'/);
});

test("la lista de matrícula evita recargas superpuestas y pagina el padrón",()=>{
  assert.match(frontend,/let matCargaPromesa = null/);
  assert.match(frontend,/token!==matCargaToken \|\| anioSolicitado!==matAnio/);
  assert.match(frontend,/const MAT_POR_PAGINA = 60/);
  assert.match(frontend,/listaCompleta\.slice\(inicio,fin\)/);
  assert.match(frontend,/id="mat-paginacion"/);
  assert.match(frontend,/MAT_CACHE_MS = 60000/);
});

test("guardar matrícula refresca solo el estudiante afectado",()=>{
  assert.match(matricula,/router\.get\("\/estudiante\/:id"/);
  assert.match(frontend,/async function matRefrescarEstudiante/);
  assert.match(frontend,/api\(`\/api\/matricula\/estudiante\/\$\{id\}\?anio=\$\{matAnio\}`\)/);
  assert.match(frontend,/await matRefrescarEstudiante\(id\)/);
  assert.match(frontend,/await matRefrescarEstudiante\(id,\{eliminado:true\}\)/);
});

test("el panel cuenta solo asignaciones vigentes de personal activo",()=>{
  assert.match(admin,/JOIN usuarios u ON u\.id=a\.profesor_id AND u\.activo=true AND COALESCE\(u\.eliminado,false\)=false/);
  assert.match(admin,/COALESCE\(a\.activa,true\)=true/);
  assert.match(frontend,/Asignaciones vigentes/);
});

test("beca acepta montos completos y autorización completa fecha y funcionario",()=>{
  assert.match(frontend,/id="beca-ingreso" readonly/);
  assert.match(frontend,/data-beca="ingreso" type="number"/);
  assert.match(frontend,/id="beca-monto-avancemos" maxlength="12"/);
  assert.match(frontend,/const fechaDocumento=fmtF\(fechaHoyCR\(\)\)/);
  assert.match(frontend,/Tramitado por:<\/strong> \$\{funcionario\}/);
  assert.match(frontend,/iPad, etc\.\), debido a que no son solicitados/);
});

test("Idioma y Tecnología conserva las elecciones y aplica la condición al año destino",async()=>{
  const vm=require("node:vm");
  const fuente=matricula.match(/async function condicionIdiomaTec\([\s\S]*?\n\}/)[0];
  const consultar=vm.runInNewContext(`(${fuente})`);
  for(const [condicion,resultado,espera,voca] of [
    ["regular",null,false,false],["voca",null,false,true],["convo",null,true,false],
    ["aplazado",null,true,false],["convo","aprobado",false,false],["convo","reprobado",false,false]
  ]){
    const valor=await consultar(42,2027,{query:async(sql,params)=>{
      assert.match(sql,/t\.anio=\$2/);
      assert.equal(params[1],2027);
      return {rows:[{condicion,convocatoria_estado:resultado}]};
    }});
    assert.equal(valor.enEspera,espera);
    assert.equal(valor.voca,voca);
  }
  assert.match(frontend,/lista\.filter\(e=>\(e\.condicion\|\|"regular"\)==="regular"\)/);
  assert.match(matricula,/if\(transicion\.enEspera\)convocatoria=true/);
  assert.match(matricula,/AND it\.condicion IS DISTINCT FROM 'voca'/);
  const guardar=matricula.slice(matricula.indexOf('async function guardarDatoTransicion'),
    matricula.indexOf('// Guardar idioma/tecnología'));
  assert.doesNotMatch(guardar,/UPDATE estudiantes|UPDATE matricula/);
  assert.match(guardar,/numero_boleta=EXCLUDED\.numero_boleta,actualizado_por=/);
  assert.match(frontend,/Boleta<\/th><th>Número de boleta<\/th><th>Condición/);
  assert.match(frontend,/value="\$\{htmlSeguro\(e\.numero_boleta\)\}"/);
});

test("la matrícula serializa el cierre por año y alterna talleres respetando los grupos ocupados",async()=>{
  const vm=require("node:vm");
  const fuente=matricula.match(/async function balancearSubgrupos\([\s\S]*?\n\}/)[0];
  const balancear=vm.runInNewContext(`(${fuente})`);
  const secuencia=[];
  let a=0,b=0;
  const cliente={query:async (sql,params)=>{
    assert.match(sql,/m\.estudiante_id<>\$3/);
    assert.equal(params[1],2027);
    return {rows:[{a,b}]};
  }};
  for(let i=0;i<6;i++){
    const g=await balancear(cliente,false,2,i+1,2027);
    secuencia.push(g);
    if(g==="A")a++;else b++;
  }
  assert.deepEqual(secuencia,["A","B","A","B","A","B"]);
  assert.match(matricula,/async function asignarMatricula[\s\S]*?pg_advisory_xact_lock\(\$1\)[\s\S]*?ocupadosSub/);
  assert.match(frontend,/imprimirCartaHorarioMatricula\(matEstId,matAnio,true\)/);
});

test("la beca calcula los ingresos de cada persona incluso cuando alguno es cero",async()=>{
  const vm=require("node:vm");
  const ruta=matricula.match(/router\.post\("\/beca-comedor", canAccess, ([\s\S]*?)\n\}\);/)[1]+"\n}";
  const consultas=[];
  const beca=vm.runInNewContext(`(${ruta})`,{
    obtenerAnioActivo:async()=>2026,
    pool:{query:async (sql,params)=>{consultas.push({sql,params});return {rows:[{id:7}]};}},
  });
  let resultado;
  await beca({session:{usuario:{id:1}},body:{
    estudiante_id:2,anio:2027,personas_hogar:2,ingreso_mensual:1,
    integrantes:[{nombre:"Persona A",parentesco:"Madre",ingreso:"140000.75"},{nombre:"Persona B",parentesco:"Estudiante",ingreso:"0"}]
  }},{json:r=>{resultado=r;}});
  assert.equal(resultado.ingreso_mensual,140000.75);
  assert.equal(resultado.percapita,70000.375);
  assert.equal(JSON.parse(consultas[0].params[15]).length,2);
  assert.match(consultas[1].sql,/INSERT INTO becas_comedor_anio/);
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
  assert.match(frontend,/function verResumenRubro/);
  assert.match(frontend,/function imprimirResumenRubro/);
  assert.match(frontend,/id="resumen-rubro-vista"/);
  assert.match(frontend,/Primero presioná Ver resumen/);
});

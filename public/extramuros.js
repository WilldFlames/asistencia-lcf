/* Extramuros: actividades, participantes, consecutivos y anexos oficiales. */
let extCatalogos=null;
let extEditando=null;
let extPasoActual=1;
let extResponsablesSeleccionados=[];
let extEstudiantesSeleccionados=[];

function extNombrePersona(p){return nombrePersona(p,{vacio:"—"});}
function extNombreEstudiante(p){return nombreEstudianteLista(p,{vacio:"—"});}
function extDos(n){return String(n).padStart(2,"0");}
function extConsecutivo(n,anio){return `EXT-${String(n).padStart(3,"0")}-${anio}`;}
function extFechaLarga(valor){
  if(!valor)return "—";
  const d=new Date(`${String(valor).slice(0,10)}T12:00:00`);
  return Number.isNaN(d.getTime())?String(valor):d.toLocaleDateString("es-CR",{day:"numeric",month:"long",year:"numeric"});
}
function extHora(valor){
  const t=String(valor||"").slice(0,5);if(!t)return "—";
  const [h,m]=t.split(":").map(Number);return new Date(2000,0,1,h,m).toLocaleTimeString("es-CR",{hour:"numeric",minute:"2-digit"});
}
function extNivelTexto(nivel){
  return ({7:"sétimo",8:"octavo",9:"noveno",10:"décimo",11:"undécimo",12:"duodécimo"})[Number(nivel)]||String(nivel||"—");
}

async function iniciarExtramuros(){
  try{
    if(!extCatalogos){
      extCatalogos=await api("/api/extramuros/catalogos");
      const anio=document.getElementById("ext-anio");
      anio.innerHTML=`<option value="${extCatalogos.anio}">${extCatalogos.anio} (actual)</option>`;
      document.getElementById("ext-seccion-select").innerHTML='<option value="">— Sección —</option>'+extCatalogos.secciones.map(s=>`<option value="${s.id}">${htmlSeguro(s.nombre)}</option>`).join("");
      document.getElementById("ext-responsable-select").innerHTML='<option value="">— Seleccione —</option>'+extCatalogos.responsables.map(p=>`<option value="${p.id}">${htmlSeguro(extNombrePersona(p))} · ${htmlSeguro(p.rol||"")}</option>`).join("");
    }
    await extCargarActividades();
  }catch(e){sa("alert-extramuros",e.message,"danger");}
}

function extCambiarTab(tab){
  const actividades=tab==="actividades";
  document.getElementById("ext-cont-actividades").style.display=actividades?"":"none";
  document.getElementById("ext-cont-consecutivos").style.display=actividades?"none":"";
  document.getElementById("ext-tab-actividades").classList.toggle("active",actividades);
  document.getElementById("ext-tab-consecutivos").classList.toggle("active",!actividades);
  if(!actividades)extCargarListado();
}

async function extCargarActividades(){
  const cont=document.getElementById("ext-actividades");if(!cont)return;
  cont.innerHTML='<div class="ext-empty">Cargando actividades…</div>';
  try{
    const anio=document.getElementById("ext-anio")?.value||extCatalogos?.anio||ANIO_LECTIVO_ACTIVO;
    const rows=await api(`/api/extramuros?anio=${encodeURIComponent(anio)}`);
    cont.innerHTML=rows.length?rows.map(x=>{
      const rango=x.consecutivo_desde===x.consecutivo_hasta?extConsecutivo(x.consecutivo_desde,x.anio):`${extConsecutivo(x.consecutivo_desde,x.anio)} a ${extConsecutivo(x.consecutivo_hasta,x.anio)}`;
      return `<article class="ext-card"><div class="ext-card-top"><div><h3>🚌 ${htmlSeguro(x.nombre_actividad)}</h3><p>📍 ${htmlSeguro(x.lugar_actividad)} · 📅 ${htmlSeguro(extFechaLarga(x.fecha_actividad))}</p></div><span class="ext-pill">${x.estudiantes} estudiante${x.estudiantes===1?"":"s"}</span></div><div class="ext-card-meta"><span>👥 ${x.responsables} responsable${x.responsables===1?"":"s"}</span><span>🕐 ${htmlSeguro(extHora(x.hora_salida))} – ${htmlSeguro(extHora(x.hora_regreso))}</span><span>🔢 ${htmlSeguro(rango)}</span></div><div class="ext-card-actions"><button class="btn btn-success btn-sm" onclick="extImprimir(${x.id})">🖨️ PDF completo</button><button class="btn btn-outline btn-sm" onclick="extEditar(${x.id})">✏️ Editar</button><button class="btn btn-danger btn-sm" onclick="extAnular(${x.id})">Anular</button></div></article>`;
    }).join(""):'<div class="ext-empty">Aún no hay actividades extramuros en este curso lectivo.</div>';
  }catch(e){cont.innerHTML=`<div class="alert show danger">${htmlSeguro(e.message)}</div>`;}
}

async function extCargarListado(){
  const body=document.getElementById("ext-consecutivos-body");body.innerHTML='<tr><td colspan="7" class="empty">Cargando…</td></tr>';
  try{
    const anio=document.getElementById("ext-anio")?.value||extCatalogos?.anio||ANIO_LECTIVO_ACTIVO;
    const rows=await api(`/api/extramuros/listado?anio=${encodeURIComponent(anio)}`);
    body.innerHTML=rows.length?rows.map(x=>`<tr><td><span class="ext-consecutivo">${htmlSeguro(extConsecutivo(x.consecutivo,x.anio))}</span></td><td><strong>${htmlSeguro(extNombreEstudiante(x))}</strong><br/><small>${htmlSeguro(x.cedula||"")}</small></td><td>${htmlSeguro(x.seccion_nombre||"—")}</td><td>${htmlSeguro(x.nombre_actividad)}</td><td>${htmlSeguro(fmtF(x.fecha_actividad))}</td><td>${htmlSeguro(nombreDesdeCampos(x.creador_nombre,x.creador_ap1,x.creador_ap2))}</td><td><button class="btn btn-outline btn-sm" onclick="extImprimir(${x.extramuro_id})">🖨️ PDF</button></td></tr>`).join(""):'<tr><td colspan="7" class="empty">No hay consecutivos registrados.</td></tr>';
  }catch(e){body.innerHTML=`<tr><td colspan="7"><div class="alert show danger">${htmlSeguro(e.message)}</div></td></tr>`;}
}

function extLimpiarFormulario(){
  ["ext-nombre","ext-objeto","ext-mediacion","ext-lugar","ext-salida","ext-regreso","ext-observaciones","ext-exoneracion"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("ext-fecha").value=fechaHoyCR();
  document.getElementById("ext-seccion-select").value="";
  document.getElementById("ext-estudiante-select").innerHTML='<option value="">— Primero seleccione sección —</option>';
  document.getElementById("alert-ext-modal").className="alert";
}
function extAbrirNuevo(){
  extEditando=null;extPasoActual=1;extResponsablesSeleccionados=[];extEstudiantesSeleccionados=[];extLimpiarFormulario();
  document.getElementById("ext-modal-title").textContent="🚌 Nuevo extramuros";
  extRenderResponsables();extRenderEstudiantes();extMostrarPaso();const modal=document.getElementById("modal-extramuros");modal.classList.add("show");modal.setAttribute("aria-hidden","false");
}
async function extEditar(id){
  try{
    if(!extCatalogos)await iniciarExtramuros();
    const d=await api(`/api/extramuros/${id}`),x=d.actividad;extEditando=id;extPasoActual=1;
    const valores={"ext-nombre":x.nombre_actividad,"ext-objeto":x.objeto_actividad,"ext-mediacion":x.mediacion_pedagogica,"ext-lugar":x.lugar_actividad,"ext-fecha":String(x.fecha_actividad||"").slice(0,10),"ext-salida":String(x.hora_salida||"").slice(0,5),"ext-regreso":String(x.hora_regreso||"").slice(0,5),"ext-observaciones":x.observaciones,"ext-exoneracion":x.descripcion_exoneracion};
    Object.entries(valores).forEach(([id,v])=>document.getElementById(id).value=v||"");
    extResponsablesSeleccionados=d.responsables.map(x=>Number(x.id));extEstudiantesSeleccionados=d.estudiantes.map(x=>Number(x.id));
    document.getElementById("ext-modal-title").textContent="🚌 Editar extramuros";document.getElementById("alert-ext-modal").className="alert";
    extRenderResponsables();extRenderEstudiantes();extMostrarPaso();const modal=document.getElementById("modal-extramuros");modal.classList.add("show");modal.setAttribute("aria-hidden","false");
  }catch(e){sa("alert-extramuros",e.message,"danger");}
}
function extValidarActividad(){
  const requeridos=["ext-nombre","ext-objeto","ext-mediacion","ext-lugar","ext-fecha","ext-salida","ext-regreso","ext-exoneracion"];
  if(requeridos.some(id=>!document.getElementById(id).value.trim()))return "Complete todos los datos obligatorios de la actividad.";
  if(document.getElementById("ext-regreso").value<=document.getElementById("ext-salida").value)return "La hora de regreso debe ser posterior a la salida.";
  return "";
}
function extPaso(delta){
  if(delta>0&&extPasoActual===1){const error=extValidarActividad();if(error){sa("alert-ext-modal",error,"warning");return;}}
  if(delta>0&&extPasoActual===2&&!extResponsablesSeleccionados.length){sa("alert-ext-modal","Agregue al menos una persona responsable.","warning");return;}
  extPasoActual=Math.max(1,Math.min(3,extPasoActual+delta));document.getElementById("alert-ext-modal").className="alert";extMostrarPaso();
}
function extMostrarPaso(){
  [1,2,3].forEach(n=>{document.getElementById(`ext-paso-${n}`).style.display=n===extPasoActual?"":"none";document.querySelector(`[data-ext-step="${n}"]`).classList.toggle("active",n===extPasoActual);});
  document.getElementById("ext-btn-atras").style.display=extPasoActual>1?"":"none";
  document.getElementById("ext-btn-siguiente").style.display=extPasoActual<3?"":"none";
  document.getElementById("ext-btn-guardar").style.display=extPasoActual===3?"":"none";
}
function extAgregarResponsable(){
  const id=Number(document.getElementById("ext-responsable-select").value);if(!id)return;
  if(!extResponsablesSeleccionados.includes(id))extResponsablesSeleccionados.push(id);document.getElementById("ext-responsable-select").value="";extRenderResponsables();
}
function extQuitarResponsable(id){extResponsablesSeleccionados=extResponsablesSeleccionados.filter(x=>x!==Number(id));extRenderResponsables();}
function extRenderResponsables(){
  const datos=extResponsablesSeleccionados.map(id=>extCatalogos?.responsables.find(x=>Number(x.id)===id)).filter(Boolean);
  document.getElementById("ext-responsables-lista").innerHTML=datos.length?datos.map((p,i)=>`<div class="ext-selected-item"><div><strong>${i+1}. ${htmlSeguro(extNombrePersona(p))}</strong><small>${htmlSeguro(p.rol||"")}</small></div><button type="button" onclick="extQuitarResponsable(${p.id})" aria-label="Quitar">×</button></div>`).join(""):'<div class="ext-empty">Aún no ha agregado responsables.</div>';
}
function extPoblarEstudiantes(){
  const seccion=Number(document.getElementById("ext-seccion-select").value),select=document.getElementById("ext-estudiante-select");
  const rows=ordenarEstudiantes((extCatalogos?.estudiantes||[]).filter(e=>Number(e.seccion_id)===seccion&&!extEstudiantesSeleccionados.includes(Number(e.id))));
  select.innerHTML=seccion?'<option value="">— Seleccione estudiante —</option>'+rows.map(e=>`<option value="${e.id}">${htmlSeguro(extNombreEstudiante(e))} · ${htmlSeguro(e.cedula||"")}</option>`).join(""):'<option value="">— Primero seleccione sección —</option>';
}
function extAgregarEstudiante(){
  const id=Number(document.getElementById("ext-estudiante-select").value);if(!id)return;
  if(!extEstudiantesSeleccionados.includes(id))extEstudiantesSeleccionados.push(id);extRenderEstudiantes();extPoblarEstudiantes();
}
function extQuitarEstudiante(id){extEstudiantesSeleccionados=extEstudiantesSeleccionados.filter(x=>x!==Number(id));extRenderEstudiantes();extPoblarEstudiantes();}
function extRenderEstudiantes(){
  const datos=extEstudiantesSeleccionados.map(id=>extCatalogos?.estudiantes.find(x=>Number(x.id)===id)).filter(Boolean);
  document.getElementById("ext-estudiantes-total").textContent=`${datos.length} estudiante${datos.length===1?"":"s"}`;
  document.getElementById("ext-estudiantes-lista").innerHTML=datos.length?datos.map((e,i)=>`<div class="ext-selected-item"><div><strong>${i+1}. ${htmlSeguro(extNombreEstudiante(e))}</strong><small>Sección ${htmlSeguro(e.seccion_nombre||"—")} · ${htmlSeguro(e.cedula||"")}</small></div><button type="button" onclick="extQuitarEstudiante(${e.id})" aria-label="Quitar">×</button></div>`).join(""):'<div class="ext-empty">Aún no ha agregado estudiantes.</div>';
}
function extPayload(){return {nombre_actividad:document.getElementById("ext-nombre").value.trim(),objeto_actividad:document.getElementById("ext-objeto").value.trim(),mediacion_pedagogica:document.getElementById("ext-mediacion").value.trim(),lugar_actividad:document.getElementById("ext-lugar").value.trim(),fecha_actividad:document.getElementById("ext-fecha").value,hora_salida:document.getElementById("ext-salida").value,hora_regreso:document.getElementById("ext-regreso").value,observaciones:document.getElementById("ext-observaciones").value.trim(),descripcion_exoneracion:document.getElementById("ext-exoneracion").value.trim(),responsables:extResponsablesSeleccionados,estudiantes:extEstudiantesSeleccionados};}
async function extGuardar(){
  const error=extValidarActividad();if(error){sa("alert-ext-modal",error,"warning");return;}if(!extResponsablesSeleccionados.length||!extEstudiantesSeleccionados.length){sa("alert-ext-modal","Seleccione al menos una persona responsable y un estudiante.","warning");return;}
  const boton=document.getElementById("ext-btn-guardar");boton.disabled=true;boton.textContent="Guardando…";
  try{const r=await api(extEditando?`/api/extramuros/${extEditando}`:"/api/extramuros",extEditando?"PUT":"POST",extPayload());const id=extEditando||r.id;cerrarModal("modal-extramuros");sa("alert-extramuros","Extramuros guardado correctamente. Los consecutivos ya están reservados.","success");await extCargarActividades();if(confirm("¿Desea abrir ahora el PDF completo con los tres anexos de cada estudiante?"))await extImprimir(id);}catch(e){sa("alert-ext-modal",e.message,"danger");}finally{boton.disabled=false;boton.textContent="💾 Guardar extramuros";}
}
async function extAnular(id){const motivo=prompt("Indique el motivo de la anulación. Los consecutivos quedarán en el historial y no se reutilizarán:","");if(motivo===null)return;if(!motivo.trim()){alert("Debe indicar el motivo.");return;}try{await api(`/api/extramuros/${id}`,"DELETE",{motivo:motivo.trim()});sa("alert-extramuros","Extramuros anulado. Sus consecutivos se conservaron en el historial.","success");await extCargarActividades();}catch(e){sa("alert-extramuros",e.message,"danger");}}

function extEncabezadoAnexo(numero,titulo,e,a){return `<div style="position:relative;text-align:center;margin-bottom:14px;"><div style="position:absolute;right:0;top:0;border:1.5px solid #1f3864;border-radius:5px;padding:7px 10px;font-size:10.8px;font-weight:bold;color:#1f3864;">${htmlSeguro(extConsecutivo(e.consecutivo,a.anio))}</div><div style="font-size:10.5px;">Circular DM-00013-05-2019</div><div style="font-weight:bold;font-size:15.5px;margin-top:4px;">ANEXO ${numero}</div><div style="font-weight:bold;font-size:15.5px;text-transform:uppercase;margin-top:4px;">${htmlSeguro(titulo)}</div></div>`;}
function extLinea(etiqueta,valor=""){return `<div style="margin:4px 0;"><strong>${htmlSeguro(etiqueta)}:</strong> <span style="display:inline-block;min-width:260px;border-bottom:1px solid #444;padding:0 3px;">${htmlSeguro(valor||" ")}</span></div>`;}
function extTelefonos(e){return [e.encargado_telefono,e.encargado_celular,e.encargado_telefono_trabajo,e.telefonos_emergencia].filter(Boolean).join(" / ")||"";}
function extNombreEncargado(e){return nombreDesdeCampos(e.encargado_nombre,e.encargado_ap1,e.encargado_ap2,{vacio:""});}
function extTablaEstilo(){return "width:100%;border-collapse:collapse;font-size:11.7px;line-height:1.36";}
function extTd(){return "border:1px solid #555;padding:7px;vertical-align:middle";}
function extDato(valor){return valor===null||valor===undefined||String(valor).trim()===""?"&nbsp;":htmlSeguro(valor);}
function extInfoMedica(e){
  const partes=[];
  if(e.enfermedad)partes.push(`<strong>Padecimiento o condición:</strong> ${htmlSeguro(e.enfermedad)}`);
  if(e.medicamento)partes.push(`<strong>Medicamento e indicaciones:</strong> ${htmlSeguro(e.medicamento)}`);
  return partes.join("<br/>");
}

function extPaginaAnexo1(d,e){
  const a=d.actividad,resp=d.responsables.map(extNombrePersona).join(", "),enc=extNombreEncargado(e);
  return `<div style="font-family:Arial,sans-serif;font-size:12.2px;line-height:1.42;color:#111;">${extEncabezadoAnexo(1,"Autorización de participación de la población estudiantil",e,a)}
  <table style="${extTablaEstilo()}">
    <tr><td style="${extTd()};width:31%"><strong>Nombre del centro educativo</strong></td><td style="${extTd()}">Liceo de Calle Fallas</td></tr>
    <tr><td style="${extTd()}"><strong>Docentes a cargo de la actividad</strong></td><td style="${extTd()}">${extDato(resp)}</td></tr>
    <tr><td style="${extTd()}"><strong>Nombre de la persona estudiante</strong></td><td style="${extTd()}">${extDato(extNombrePersona(e))}</td></tr>
    <tr><td style="${extTd()}"><strong>Nivel o grado</strong></td><td style="${extTd()}">${extDato(`${extNivelTexto(e.nivel)} · Sección ${e.seccion_nombre||""}`)}</td></tr>
  </table>
  <div style="border:1px solid #555;border-top:0;padding:9px 11px;text-align:justify;"><div style="font-weight:bold;text-align:center;margin-bottom:7px;">Autorización de participación</div>Mediante el presente documento, yo <strong>${extDato(enc)}</strong>, cédula de identidad <strong>${extDato(e.encargado_cedula)}</strong>, en calidad de <strong>${extDato(e.encargado_parentesco)}</strong>, autorizo la participación de la persona estudiante <strong>${extDato(extNombrePersona(e))}</strong> en la actividad denominada <strong>${extDato(a.nombre_actividad)}</strong>, actividad que se ejecutará fuera del centro educativo en <strong>${extDato(a.lugar_actividad)}</strong>, el día <strong>${extDato(extFechaLarga(a.fecha_actividad))}</strong>.</div>
  <div style="border:1px solid #555;border-top:0;padding:9px 11px;text-align:justify;"><div style="font-weight:bold;margin-bottom:7px;">Consentimiento informado para el uso de fotografías, videos y otros con fines educativos</div>Autorizo a su vez el uso de la imagen y el nombre del estudiante, que sean recopilados mediante fotografías, videos, textos y otros por parte del personal docente y autoridades del Ministerio de Educación Pública. Esta autorización se brinda únicamente con fines educativos, para la promoción y divulgación de actividades organizadas por el centro educativo o el Ministerio de Educación Pública.<div style="margin-top:8px;">☐ SÍ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ☐ NO</div></div>
  <div style="border:1px solid #555;border-top:0;padding:9px 11px;min-height:72px;"><strong>Información médica para considerar por el centro educativo:</strong><div style="margin-top:8px;">${extInfoMedica(e)||"&nbsp;<br/>&nbsp;"}</div></div>
  <div style="border:1px solid #555;border-top:0;padding:9px 11px;text-align:justify;"><strong>Observaciones:</strong> Únicamente los estudiantes que presenten la información completa solicitada en el Anexo 2, junto con las copias solicitadas en el Anexo 2 y las firmas correspondientes en los anexos 1 y 3, podrán participar de la actividad.</div>
  <table style="${extTablaEstilo()}"><tr><td style="${extTd()};width:31%;text-align:center;"><strong>Información de contacto del encargado legal</strong></td><td style="${extTd()}"><strong>Teléfonos:</strong> ${extDato(extTelefonos(e))}<br/><strong>Correo electrónico:</strong> ${extDato(e.encargado_email)}</td></tr><tr><td style="${extTd()};text-align:center;"><strong>Fecha de firma</strong></td><td style="${extTd()};height:42px;">&nbsp;</td></tr><tr><td style="${extTd()};text-align:center;"><strong>Firma del encargado legal</strong></td><td style="${extTd()};height:52px;">&nbsp;</td></tr></table></div>`;
}

function extPaginaAnexo2(d,e){
  const a=d.actividad;
  const responsables=d.responsables.map((p,i)=>`${i+1}. ${htmlSeguro(extNombrePersona(p))}<br/><span style="color:#444;">Teléfono: ____________________</span>`).join("<br/>")||"&nbsp;";
  const firmas=d.responsables.map((p,i)=>`${i+1}. ______________________________ &nbsp; ${htmlSeguro(extNombrePersona(p))}`).join("<br/>")||"&nbsp;";
  return `<div style="font-family:Arial,sans-serif;font-size:11.5px;line-height:1.36;color:#111;">${extEncabezadoAnexo(2,"Formulario · Plan de actividad ejecutada fuera del centro educativo",e,a)}
  <div style="font-size:11.5px;margin-bottom:8px;"><strong>Persona estudiante:</strong> ${extDato(extNombrePersona(e))} · <strong>Sección:</strong> ${extDato(e.seccion_nombre)}</div>
  <table style="${extTablaEstilo()}"><tr><td style="${extTd()};width:27%"><strong>Centro Educativo</strong></td><td style="${extTd()}">Liceo de Calle Fallas</td></tr><tr><td style="${extTd()}"><strong>Nombre de la actividad</strong></td><td style="${extTd()}">${extDato(a.nombre_actividad)}</td></tr><tr><td style="${extTd()}"><strong>Objeto de la actividad</strong></td><td style="${extTd()}">${extDato(a.objeto_actividad)}</td></tr><tr><td style="${extTd()}"><strong>Actividades y mediación pedagógica</strong></td><td style="${extTd()}">${extDato(a.mediacion_pedagogica)}</td></tr><tr><td style="${extTd()}"><strong>Lugar de ejecución de la actividad</strong></td><td style="${extTd()}">${extDato(a.lugar_actividad)}</td></tr></table>
  <table style="${extTablaEstilo()}"><tr><td style="${extTd()};width:50%;"><strong>Personal docente que participa en la actividad (nombre completo y número telefónico):</strong><div style="margin-top:4px;">${responsables}</div></td><td style="${extTd()};"><strong>Representantes legales del estudiantado que participan en la actividad (nombre completo y número telefónico):</strong><div style="margin-top:5px;">1. __________________________________________<br/>Teléfono: ____________________<br/><br/>2. __________________________________________<br/>Teléfono: ____________________</div></td></tr></table>
  <table style="${extTablaEstilo()}"><tr><td style="${extTd()};width:27%;"><strong>Documentación adicional</strong><br/>(Presentar junto con este anexo los documentos mencionados a la derecha)</td><td style="${extTd()}">☐ Permisos o autorizaciones para la participación del estudiantado (Anexos 1 y 2).<br/>☐ Copia de la cédula de identidad del encargado legal y del estudiante.<br/>☐ Compromisos de participación de representantes legales.<br/>☐ Póliza estudiantil.</td></tr><tr><td style="${extTd()}"><strong>Firma del personal docente a cargo de la actividad</strong></td><td style="${extTd()};line-height:1.55;">${firmas}</td></tr></table>
  <table style="${extTablaEstilo()}"><tr><td style="${extTd()};width:27%;"><strong>Autorización por parte de la Dirección del centro educativo</strong><div style="margin-top:8px;">☐ SÍ &nbsp;&nbsp;&nbsp; ☐ NO</div></td><td style="${extTd()};width:40%;text-align:center;"><strong>Nombre y firma de la persona directora, sello</strong><div style="height:28px;"></div><strong>${extDato(d.config.director_nombre)}</strong><br/>Firma: ____________________ &nbsp; Sello: __________</td><td style="${extTd()};"><strong>Observaciones</strong><div style="margin-top:4px;white-space:pre-wrap;">${extDato(a.observaciones)}</div><div style="margin-top:4px;"><strong>Fecha:</strong> ${extDato(extFechaLarga(a.fecha_actividad))}<br/><strong>Horario:</strong> ${extDato(`${extHora(a.hora_salida)} a ${extHora(a.hora_regreso)}`)}</div></td></tr></table></div>`;
}

function extPaginaAnexo3(d,e){
  const a=d.actividad,enc=extNombreEncargado(e);
  return `<div style="font-family:Arial,sans-serif;font-size:12.2px;line-height:1.58;color:#111;">${extEncabezadoAnexo(3,"Exoneración de responsabilidad de salida del estudiante del centro educativo en caso de accidente",e,a)}
  <p style="text-align:justify;margin:15px 0 12px;">Yo, <strong>${extDato(enc)}</strong>, con identificación N.° <strong>${extDato(e.encargado_cedula)}</strong>, responsable legal del estudiante <strong>${extDato(extNombrePersona(e))}</strong>, de la sección <strong>${extDato(e.seccion_nombre)}</strong>; de acuerdo con lo que establece el artículo 5 del Código de la Niñez y la Adolescencia y el Código de Familia, en el ejercicio pleno de la patria potestad que me confiere la ley; exonero a los funcionarios del Liceo de Calle Fallas de toda responsabilidad legal en casos de fuerza mayor o caso fortuito, culpa de la víctima o hechos de un tercero, según lo establece la Ley General de la Administración Pública, artículo 190, inciso 1, que se pueda presentar en el desarrollo de <strong>${extDato(a.descripcion_exoneracion)}</strong>.</p>
  <p style="text-align:justify;margin:12px 0;">Asimismo, ratifico que asumo la responsabilidad de cualquier accidente o lesión que pueda tener mi hijo(a) y que se pueda derivar del trayecto de ida y regreso. También exonero de toda responsabilidad a los docentes que acompañan como representantes de la institución para esta actividad, así como a la persona directora del Liceo de Calle Fallas, por cualquier accidente, lesión, enfermedad, muerte o problema que pueda suceder en la salida, traslado y durante el tiempo de permanencia del estudiante durante la actividad.</p>
  <p style="text-align:justify;margin:12px 0;">Si me retraso en recoger a mi hijo(a) a la hora correspondiente indicada en la boleta de permiso de salida de Giras Educativas, exonero al Centro Educativo de toda responsabilidad en caso de que se pueda presentar alguna situación que pueda lesionar su integridad y estoy en el entendido de que se aplicará el procedimiento de llamar al PANI y a la Policía de Proximidad para la debida protección de la persona menor de edad.</p>
  <p style="text-align:justify;margin:12px 0;">Declaro que, como encargado legal, apoyaré la organización y desarrollo de la actividad; notificaré a los responsables algún padecimiento de salud que pueda presentar mi hijo(a), el cual debe ser del conocimiento del Centro Educativo; y llenaré debidamente la boleta de datos personales del estudiante sin omitir información importante para salvaguardar la atención médica, si así lo amerita, durante el desarrollo de la actividad.</p>
  <p style="margin:18px 0 0;">Firmo en la ciudad de Desamparados, a los ______ días del mes de __________________ del año <strong>${htmlSeguro(a.anio)}</strong>.</p>
  <div style="display:grid;grid-template-columns:1.5fr .9fr;gap:48px;margin-top:84px;text-align:center;"><div style="border-top:1px solid #333;padding-top:8px;">Nombre y firma del encargado legal<br/><strong>${extDato(enc)}</strong></div><div style="border-top:1px solid #333;padding-top:8px;">Número de identificación<br/><strong>${extDato(e.encargado_cedula)}</strong></div></div></div>`;
}

async function extImprimir(id){
  const ventana=window.open("","_blank");if(ventana){ventana.document.write('<p style="font-family:Arial;padding:25px">Preparando todos los anexos…</p>');}
  try{
    const d=await api(`/api/extramuros/${id}`);if(!d.estudiantes.length)throw new Error("La actividad no tiene estudiantes activos.");
    const paginas=[];d.estudiantes.forEach(e=>paginas.push(extPaginaAnexo1(d,e),extPaginaAnexo2(d,e),extPaginaAnexo3(d,e)));
    await imprimirPaginasPDFMEP(paginas,`Extramuros_${d.actividad.anio}_${d.actividad.id}.pdf`,ventana);
  }catch(e){if(ventana)ventana.close();sa("alert-extramuros",e.message,"danger");}
}

async function extEsperarImagenes(contenedor){await Promise.all([...contenedor.querySelectorAll("img")].map(img=>img.complete&&img.naturalWidth?Promise.resolve():new Promise(r=>{img.onload=r;img.onerror=r;setTimeout(r,3000);})));}
async function imprimirPaginasPDFMEP(paginasHTML,nombreArchivo,ventanaPreparada=null){
  if(!Array.isArray(paginasHTML)||!paginasHTML.length)throw new Error("No hay anexos para imprimir.");
  const JsPDF=window.jspdf?.jsPDF;if(!JsPDF)throw new Error("No se pudo cargar el generador PDF.");
  const crearOculto=(ancho,html)=>{const outer=document.createElement("div");outer.style.cssText="height:0;overflow:hidden;position:relative;z-index:-1";const div=document.createElement("div");div.style.cssText=`width:${ancho}px;background:#fff;font-family:Arial,sans-serif;color:#111;box-sizing:border-box;`;div.innerHTML=html;outer.appendChild(div);document.body.appendChild(outer);return {outer,div};};
  const header=crearOculto(720,`<table style="width:100%;border-collapse:collapse"><tr><td style="width:23%;padding-right:8px"><img src="${MEP_LOGO}" style="width:100%;max-height:60px;object-fit:contain;display:block"></td><td style="width:25%;border-left:2px solid #1F3864;padding:4px 10px;font-weight:bold;font-size:11px;color:#1F3864">Dirección Regional<br>Desamparados</td><td style="width:26%;border-left:2px solid #1F3864;padding:4px 10px;font-weight:bold;font-size:11px;color:#1F3864">Supervisión Educativa<br>Circuito 07</td><td style="width:26%;border-left:2px solid #1F3864;padding:4px 10px;font-weight:bold;font-size:11px;color:#1F3864">Liceo de Calle<br>Fallas</td></tr></table>`);
  const footer=crearOculto(720,`<div style="background:#1F3864;color:#fff;padding:9px 14px;text-align:center;font-size:10px;font-weight:bold;line-height:1.4">San José Desamparados, 1 km al sur del Multicentro Desamparados<br>Teléfono 2250-0590 / 2250-0614<br>lic.callefallas@mep.go.cr / www.mep.go.cr</div>`);
  await extEsperarImagenes(header.div);const hc=await html2canvas(header.div,{scale:2,useCORS:true,backgroundColor:"#fff",logging:false});const fc=await html2canvas(footer.div,{scale:2,useCORS:true,backgroundColor:"#fff",logging:false});header.outer.remove();footer.outer.remove();
  const hData=hc.toDataURL("image/jpeg",.95),fData=fc.toDataURL("image/jpeg",.95),pdf=new JsPDF({unit:"mm",format:"letter",orientation:"portrait"});
  const pw=pdf.internal.pageSize.getWidth(),ph=pdf.internal.pageSize.getHeight(),officialX=10,officialW=pw-20,hy=8,hh=hc.height*officialW/hc.width,fh=fc.height*officialW/fc.width,fy=ph-fh-8,contentX=15,contentY=Math.max(28,hy+hh+3),contentW=pw-30,contentH=fy-contentY-3;
  try{
    for(let i=0;i<paginasHTML.length;i++){
      if(i)pdf.addPage("letter","portrait");
      const pagina=crearOculto(680,`<div style="width:680px;min-height:760px;background:#fff;box-sizing:border-box;padding:0 2px;">${paginasHTML[i]}</div>`);await extEsperarImagenes(pagina.div);
      const canvas=await html2canvas(pagina.div,{scale:1.65,useCORS:true,backgroundColor:"#fff",logging:false,windowWidth:680});pagina.outer.remove();
      const ratio=Math.min(contentW/canvas.width,contentH/canvas.height),w=canvas.width*ratio,h=canvas.height*ratio,x=contentX+(contentW-w)/2;
      pdf.addImage(hData,"JPEG",officialX,hy,officialW,hh);pdf.addImage(canvas.toDataURL("image/jpeg",.93),"JPEG",x,contentY,w,h);pdf.addImage(fData,"JPEG",officialX,fy,officialW,fh);
      pdf.setFont("helvetica","normal");pdf.setFontSize(7.5);pdf.setTextColor(100,116,139);pdf.text(`Página ${i+1} de ${paginasHTML.length}`,pw-officialX,fy-1.5,{align:"right"});canvas.width=1;canvas.height=1;
      if(i%4===3)await new Promise(r=>setTimeout(r,0));
    }
    hc.width=1;hc.height=1;fc.width=1;fc.height=1;const blob=pdf.output("blob"),url=URL.createObjectURL(blob),w=ventanaPreparada||window.open("","_blank");
    if(w){w.location.href=url;setTimeout(()=>{try{w.print();}catch(_){ }},1200);}else{pdf.save(nombreArchivo);alert("El navegador bloqueó la ventana emergente. El PDF se descargó en su lugar.");}setTimeout(()=>URL.revokeObjectURL(url),120000);
  }catch(e){hc.width=1;hc.height=1;fc.width=1;fc.height=1;throw e;}
}

let giEstudiantes=[],giEpiActual=null,giEpiPuedeEditar=false;
const giEsc=v=>htmlSeguro(v==null?'':String(v));
async function configurarGestionEstudiantil(){
  if(['admin','auxiliar'].includes(ME?.rol)){
    ['nav-traslados-ingreso','nav-encargados-temporales'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display='';});
    const sec=document.getElementById('sec-gestion');if(sec)sec.style.display='';
  }
  try{const a=await api('/api/epi/acceso');if(a?.acceso){document.getElementById('nav-epi').style.display='';document.getElementById('sec-gestion').style.display='';}}
  catch(_){ }
}
async function giCargarEstudiantes(){
  giEstudiantes=await api('/api/gestion-estudiantil/estudiantes')||[];
  const ops='<option value="">— Seleccione —</option>'+giEstudiantes.map(e=>`<option value="${e.id}">${giEsc(e.seccion)} · ${giEsc(e.nombre)} · ${giEsc(e.cedula)}</option>`).join('');
  ['tras-estudiante','et-estudiante'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=ops;});
}
async function giIniciarTraslados(){
  await giCargarEstudiantes();document.getElementById('tras-fecha').value=fechaHoyCR();await giCargarListaTraslados();
}
async function giCargarMateriasTraslado(){
  const id=document.getElementById('tras-estudiante').value,box=document.getElementById('tras-materias');
  if(!id){box.className='empty';box.innerHTML='Seleccione un estudiante.';return;}
  try{const mats=await api(`/api/gestion-estudiantil/traslados/materias/${id}`);box.className='';box.innerHTML=mats.length?`<div class="table-wrap"><table><thead><tr><th>Materia</th><th style="width:180px">Nota del I período</th></tr></thead><tbody>${mats.map(m=>`<tr><td>${giEsc(m.nombre)}</td><td><input class="tras-nota" data-materia="${m.id}" type="number" min="0" max="100" step="0.01" placeholder="0–100"></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No se encontraron materias en la sección actual.</div>';}catch(e){box.innerHTML=`<div class="alert danger show">${giEsc(e.message)}</div>`;}
}
async function giGuardarTraslado(){
  const notas=[...document.querySelectorAll('.tras-nota')].filter(x=>x.value!=='').map(x=>({materia_id:Number(x.dataset.materia),nota:Number(x.value)}));
  try{await api('/api/gestion-estudiantil/traslados','POST',{estudiante_id:Number(document.getElementById('tras-estudiante').value),fecha_ingreso:document.getElementById('tras-fecha').value,centro_procedencia:document.getElementById('tras-centro').value,observaciones:document.getElementById('tras-observaciones').value,notas});sa('alert-traslado-ingreso','Traslado y notas certificados guardados. Los promedios docentes ya usarán esta información.','success');await giCargarListaTraslados();}catch(e){sa('alert-traslado-ingreso',e.message,'danger');}
}
async function giCargarListaTraslados(){
  const rows=await api('/api/gestion-estudiantil/traslados')||[],box=document.getElementById('tras-lista');
  box.innerHTML=rows.length?`<table><thead><tr><th>Estudiante</th><th>Ingreso / procedencia</th><th>Notas del I período</th><th>Registró</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${giEsc(r.estudiante_nombre)}</strong><br><small>${giEsc(r.cedula)} · ${giEsc(r.seccion)}</small></td><td>${fmtF(r.fecha_ingreso)}<br>${giEsc(r.centro_procedencia)}</td><td>${(r.notas||[]).map(n=>`<span class="badge info" style="margin:2px">${giEsc(n.materia)}: ${Number(n.nota).toFixed(2)}</span>`).join('')}</td><td>${giEsc(r.registrado_por_nombre)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No hay traslados registrados en este curso lectivo.</div>';
}
async function giIniciarEncargados(){await giCargarEstudiantes();document.getElementById('et-inicio').value=fechaHoyCR();await giCargarEncargados();}
function giCambioPermanente(){const p=document.getElementById('et-permanente').checked;document.getElementById('et-fin').disabled=p;if(p)document.getElementById('et-fin').value='';}
async function giGuardarEncargado(){
  const v=id=>document.getElementById(id).value;
  const body={estudiante_id:Number(v('et-estudiante')),cedula:v('et-cedula'),nombre:v('et-nombre'),primer_apellido:v('et-apellido1'),segundo_apellido:v('et-apellido2'),parentesco:v('et-parentesco'),nacionalidad:v('et-nacionalidad'),profesion:v('et-profesion'),telefono:v('et-telefono'),celular:v('et-celular'),telefono_trabajo:v('et-telefono-trabajo'),lugar_trabajo:v('et-lugar-trabajo'),email:v('et-email'),direccion:v('et-direccion'),motivo:v('et-motivo'),fecha_inicio:v('et-inicio'),fecha_fin:v('et-fin'),entidad_autoriza:v('et-entidad'),numero_resolucion:v('et-resolucion'),permanente:document.getElementById('et-permanente').checked};
  if(body.permanente&&!confirm('Esto sustituirá al encargado principal actual, pero conservará su historial. ¿Continuar?'))return;
  try{await api('/api/gestion-estudiantil/encargados-temporales','POST',body);sa('alert-enc-temporal',body.permanente?'Encargado sustituido y trazabilidad conservada.':'Encargado temporal registrado.','success');await giCargarEncargados();}catch(e){sa('alert-enc-temporal',e.message,'danger');}
}
async function giCargarEncargados(){
  const rows=await api('/api/gestion-estudiantil/encargados-temporales')||[],box=document.getElementById('et-lista');
  box.innerHTML=rows.length?`<table><thead><tr><th>Estudiante</th><th>Encargado</th><th>Vigencia</th><th>Autorización</th><th>Estado</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${giEsc(r.estudiante_nombre)}</strong><br><small>${giEsc(r.seccion)}</small></td><td>${giEsc([r.nombre,r.primer_apellido,r.segundo_apellido].filter(Boolean).join(' '))}<br><small>${giEsc(r.parentesco)} · ${giEsc(r.celular)}</small></td><td>${fmtF(r.fecha_inicio)} — ${r.permanente?'Permanente':fmtF(r.fecha_fin)}<br><small>${giEsc(r.motivo)}</small></td><td>${giEsc(r.entidad_autoriza)}<br><small>Resolución ${giEsc(r.numero_resolucion)}</small></td><td><span class="badge ${r.estado==='vigente'?'success':'info'}">${giEsc(r.estado)}</span></td><td>${r.estado==='vigente'?`<button class="btn btn-danger btn-xs" onclick="giFinalizarEncargado(${r.id})">Finalizar</button>`:''}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">Sin encargados temporales registrados.</div>';
}
async function giFinalizarEncargado(id){if(!confirm('¿Finalizar la vigencia de este encargado temporal?'))return;try{await api(`/api/gestion-estudiantil/encargados-temporales/${id}/finalizar`,'PUT',{});await giCargarEncargados();}catch(e){sa('alert-enc-temporal',e.message,'danger');}}

async function cargarInformeConstancias(){
  const tipo=document.getElementById('const-informe-tipo')?.value||'',rows=await api(`/api/gestion-estudiantil/constancias${tipo?'?tipo='+tipo:''}`)||[],box=document.getElementById('const-informe');
  box.innerHTML=rows.length?`<table><thead><tr><th>Consecutivo</th><th>Documento</th><th>Estudiante</th><th>Fecha</th><th>Emitido por</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${giEsc(r.consecutivo)}</strong></td><td>${r.tipo==='retiro'?'Constancia de retiro':'Constancia de estudiante regular'}</td><td>${giEsc(r.estudiante_nombre)}<br><small>${giEsc(r.estudiante_cedula)} · ${giEsc(r.seccion_nombre)}</small></td><td>${fmtF(r.fecha_documento)}</td><td>${giEsc(r.emitida_por_nombre||'Usuario histórico')}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">Todavía no se han emitido constancias en esta serie.</div>';
}

async function giIniciarEPI(){
  try{const acc=await api('/api/epi/acceso');giEpiPuedeEditar=ME.rol==='admin'||!acc.supervisor;document.getElementById('epi-form-edicion').style.display=giEpiPuedeEditar?'':'none';if(!acc.supervisor){document.getElementById('epi-nivel').value=acc.nivel;document.getElementById('epi-nivel').disabled=true;}if(ME.rol==='admin')await giConfigEPI();await giCargarEPI();}catch(e){sa('alert-epi',e.message,'danger');}
}
async function giConfigEPI(){
  const [miembros,profs]=await Promise.all([api('/api/epi/miembros'),api('/api/admin/profesores')]);const map=new Map((miembros||[]).map(x=>[Number(x.nivel),x]));
  const box=document.getElementById('epi-config');box.style.display='';box.innerHTML=`<strong>Configuración del Comité EPI</strong><p style="font-size:12px;color:var(--muted)">Asigne exactamente un profesor diferente a cada nivel.</p><div class="form-grid">${[7,8,9,10,11].map(n=>`<div class="fg"><label>${n}.° año</label><select id="epi-miembro-${n}"><option value="">— Profesor —</option>${(profs||[]).map(p=>`<option value="${p.id}" ${map.get(n)?.usuario_id==p.id?'selected':''}>${giEsc(nombrePersona(p))}</option>`).join('')}</select><button class="btn btn-outline btn-xs" style="margin-top:5px" onclick="giAsignarEPI(${n})">Guardar</button></div>`).join('')}</div>`;
}
async function giAsignarEPI(n){try{await api(`/api/epi/miembros/${n}`,'PUT',{usuario_id:Number(document.getElementById(`epi-miembro-${n}`).value)});sa('alert-epi',`Responsable de ${n}.° actualizado.`,'success');await giConfigEPI();}catch(e){sa('alert-epi',e.message,'danger');}}
async function giCargarEPI(){
  const nivel=document.getElementById('epi-nivel').value,rows=(await api(`/api/epi/alertas${nivel?'?nivel='+nivel:''}`)).alertas||[],box=document.getElementById('epi-lista');
  box.innerHTML=rows.length?`<table><thead><tr><th>Estudiante</th><th>Nivel / sección</th><th>Alerta</th><th>Docente</th><th>Seguimientos EPI</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${giEsc(r.estudiante_nombre)}</strong><br><small>${giEsc(r.cedula)}</small></td><td>${r.nivel}.° · ${giEsc(r.seccion)}</td><td>${giEsc(r.materia)}<br><span class="badge warning">${giEsc(r.estado)}</span></td><td>${giEsc(r.profesor)}</td><td style="text-align:center">${r.seguimientos_epi}</td><td><button class="btn btn-primary btn-xs" onclick="giAbrirEPI(${r.id})">Ver / seguir</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No hay alertas tempranas abiertas para este alcance.</div>';
}
async function giAbrirEPI(id){try{giEpiActual=id;const d=await api(`/api/epi/alertas/${id}`),a=d.alerta;document.getElementById('epi-detalle').innerHTML=`<div style="padding:10px;background:#eff6ff;border-radius:8px"><strong>${giEsc(a.estudiante_nombre)}</strong> · ${giEsc(a.seccion)}<br>${giEsc(a.materia)} · Docente: ${giEsc(a.profesor)}</div><h3>Historial EPI</h3>${d.seguimientos.length?d.seguimientos.map(s=>`<div style="border-left:3px solid #2563eb;padding:8px 10px;margin:7px 0;background:#f8fafc"><strong>${s.tipo==='recomendacion'?'Recomendación':'Seguimiento'}</strong> · ${giEsc(s.registrado_por_nombre)}<br>${giEsc(s.contenido)}<br><small>${new Date(s.created_at).toLocaleString('es-CR')}</small></div>`).join(''):'<div class="empty">Sin seguimiento EPI todavía.</div>'}`;document.getElementById('epi-contenido').value='';document.getElementById('modal-epi').classList.add('show');}catch(e){sa('alert-epi',e.message,'danger');}}
async function giGuardarSeguimientoEPI(){try{await api(`/api/epi/alertas/${giEpiActual}/seguimientos`,'POST',{tipo:document.getElementById('epi-tipo').value,contenido:document.getElementById('epi-contenido').value});await giAbrirEPI(giEpiActual);await giCargarEPI();}catch(e){sa('alert-epi-modal',e.message,'danger');}}

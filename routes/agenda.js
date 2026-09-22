const router = require("express").Router();
const { pool } = require("../db");
const { obtenerAnioActivo } = require("../utils/lectivo");

const TIPOS = new Set(["reunion","orientacion","debido_proceso","pauta","atencion_familia","institucional","otro"]);
const ROLES_AGENDA = new Set(["admin","administrativo","secretaria","auxiliar","profesor","profesor_guia","orientador","bibliotecologa"]);
const limpio = v => String(v == null ? "" : v).trim();
const fechaOk = v => /^\d{4}-\d{2}-\d{2}$/.test(limpio(v));
const horaOk = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(limpio(v).slice(0,5));
const esAdmin = u => ["admin","administrativo"].includes(u.rol);
const esOrientador = u => u.rol === "orientador" || (u.funciones_extra || []).includes("orientador");
function autorizado(req,res,next){
  const u=req.session.usuario;
  if(!u || (!ROLES_AGENDA.has(u.rol) && !(u.funciones_extra||[]).some(r=>ROLES_AGENDA.has(r))))
    return res.status(403).json({error:"Sin acceso a la agenda institucional."});
  next();
}
function fechaTexto(f){const [a,m,d]=String(f).slice(0,10).split("-");return `${d}/${m}/${a}`;}
async function notificar(db, usuarioId, mensaje, eventoId){
  await db.query(`INSERT INTO notificaciones(usuario_id,tipo,mensaje,referencia_id,destino)
    VALUES($1,'agenda',$2,$3,'citas')`,[usuarioId,mensaje,eventoId]).catch(()=>{});
}
async function bloqueExplicito(db, usuarioId, anio, fecha, inicio, fin){
  const r=await db.query(`SELECT motivo FROM agenda_bloqueos
    WHERE usuario_id=$1 AND anio=$2 AND activo=true
      AND (fecha=$3::date OR (fecha IS NULL AND dia_semana=EXTRACT(ISODOW FROM $3::date)))
      AND hora_inicio < $5::time AND hora_fin > $4::time LIMIT 1`,[usuarioId,anio,fecha,inicio,fin]);
  return r.rows[0]||null;
}
async function validarOrientacion(db, usuarioId, anio, fecha, inicio, fin){
  const r=await db.query(`SELECT hora_inicio::text,hora_fin::text FROM agenda_horarios_oficina
    WHERE usuario_id=$1 AND anio=$2 AND activo=true AND dia_semana=EXTRACT(ISODOW FROM $3::date)`,[usuarioId,anio,fecha]);
  if(!r.rows.length) return "La orientadora no tiene horario de oficina configurado para ese día.";
  const h=r.rows[0];
  if(inicio < h.hora_inicio.slice(0,5) || fin > h.hora_fin.slice(0,5))
    return `La orientadora atiende ese día de ${h.hora_inicio.slice(0,5)} a ${h.hora_fin.slice(0,5)}.`;
  return null;
}
async function compromisoExistente(db,usuarioId,fecha,inicio,fin){
  const r=await db.query(`SELECT 1 FROM (
    SELECT e.hora_inicio inicio,e.hora_fin fin
    FROM agenda_eventos e JOIN agenda_participantes p ON p.evento_id=e.id
    WHERE p.usuario_id=$1 AND p.estado<>'rechazado' AND e.estado='activo' AND e.fecha=$2
    UNION ALL
    SELECT c.hora inicio,c.hora+make_interval(mins=>c.duracion_min) fin
    FROM citas c LEFT JOIN citas_participantes cp ON cp.cita_id=c.id AND cp.usuario_id=$1
    WHERE (c.profesor_id=$1 OR cp.usuario_id=$1) AND COALESCE(cp.estado,'aceptado')<>'rechazado'
      AND c.estado IN ('pendiente','confirmada') AND c.fecha=$2
  ) x WHERE x.inicio<$4::time AND x.fin>$3::time LIMIT 1`,[usuarioId,fecha,inicio,fin]);
  return r.rows.length>0;
}

router.use(autorizado);

router.get("/personal", async (req,res)=>{
  const anio=await obtenerAnioActivo();
  const r=await pool.query(`SELECT u.id,u.nombre,u.primer_apellido,u.segundo_apellido,u.rol,
    COALESCE(STRING_AGG(DISTINCT s.nombre,', ' ORDER BY s.nombre),'') AS secciones_orientacion
    FROM usuarios u LEFT JOIN seccion_orientador_anio so ON so.orientador_id=u.id AND so.anio=$1
    LEFT JOIN secciones s ON s.id=so.seccion_id
    WHERE u.activo=true AND COALESCE(u.eliminado,false)=false
      AND u.rol IN ('admin','administrativo','secretaria','auxiliar','profesor','profesor_guia','orientador','bibliotecologa')
    GROUP BY u.id ORDER BY u.primer_apellido,u.segundo_apellido,u.nombre`,[anio]);
  res.json(r.rows);
});

router.get("/eventos", async (req,res)=>{
  const uid=req.session.usuario.id, anio=await obtenerAnioActivo();
  const desde=fechaOk(req.query.desde)?req.query.desde:`${anio}-01-01`;
  const hasta=fechaOk(req.query.hasta)?req.query.hasta:`${anio}-12-31`;
  const propios=await pool.query(`SELECT e.id,e.titulo,e.tipo,e.fecha::text,e.hora_inicio::text,e.hora_fin::text,
    e.lugar,e.descripcion,e.institucional,e.estado,e.creador_id,
    TRIM(CONCAT_WS(' ',uc.nombre,uc.primer_apellido,uc.segundo_apellido)) creador,
    ap.estado mi_estado,ap.respuesta,
    COALESCE(json_agg(json_build_object('id',p.usuario_id,'nombre',TRIM(CONCAT_WS(' ',u.nombre,u.primer_apellido,u.segundo_apellido)),
      'estado',p.estado,'respuesta',p.respuesta,'propuesta_fecha',p.propuesta_fecha,'propuesta_inicio',p.propuesta_inicio,'propuesta_fin',p.propuesta_fin)
      ORDER BY u.primer_apellido,u.nombre) FILTER(WHERE p.id IS NOT NULL),'[]') participantes
    FROM agenda_eventos e JOIN usuarios uc ON uc.id=e.creador_id
    LEFT JOIN agenda_participantes ap ON ap.evento_id=e.id AND ap.usuario_id=$1
    LEFT JOIN agenda_participantes p ON p.evento_id=e.id LEFT JOIN usuarios u ON u.id=p.usuario_id
    WHERE e.anio=$2 AND e.fecha BETWEEN $3 AND $4 AND e.estado='activo'
      AND (e.creador_id=$1 OR ap.usuario_id=$1 OR (e.institucional=true AND $5::boolean=true))
    GROUP BY e.id,uc.id,ap.id ORDER BY e.fecha,e.hora_inicio`,[uid,anio,desde,hasta,esAdmin(req.session.usuario)]);
  const citas=await pool.query(`SELECT c.id,c.fecha::text,c.hora::text,c.duracion_min,c.motivo,c.estado,c.pendiente_de,
    cp.estado participante_estado,
    TRIM(CONCAT_WS(' ',e.nombre,e.primer_apellido,e.segundo_apellido)) estudiante,s.nombre seccion
    FROM citas c JOIN estudiantes e ON e.id=c.estudiante_id LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN citas_participantes cp ON cp.cita_id=c.id AND cp.usuario_id=$1
    WHERE (c.profesor_id=$1 OR cp.usuario_id=$1) AND c.anio=$2 AND c.fecha BETWEEN $3 AND $4 AND c.estado<>'cancelada'
    ORDER BY c.fecha,c.hora`,[uid,anio,desde,hasta]);
  const blocks=await pool.query(`SELECT id,fecha::text,dia_semana,hora_inicio::text,hora_fin::text,motivo
    FROM agenda_bloqueos WHERE usuario_id=$1 AND anio=$2 AND activo=true ORDER BY dia_semana,fecha,hora_inicio`,[uid,anio]);
  res.json({eventos:propios.rows,citas:citas.rows,bloqueos:blocks.rows});
});

router.post("/eventos", async (req,res)=>{
  const u=req.session.usuario, anio=await obtenerAnioActivo();
  const compromisoPropio=req.body.compromiso_propio===true;
  const titulo=limpio(req.body.titulo), tipo=limpio(req.body.tipo)||"reunion", fecha=limpio(req.body.fecha);
  const inicio=limpio(req.body.hora_inicio).slice(0,5), fin=limpio(req.body.hora_fin).slice(0,5);
  const participantes=[...new Set((Array.isArray(req.body.participantes)?req.body.participantes:[]).map(Number).filter(Boolean))];
  const institucional=!!req.body.institucional;
  if(titulo.length<3 || !TIPOS.has(tipo) || !fechaOk(fecha) || !horaOk(inicio) || !horaOk(fin) || fin<=inicio)
    return res.status(400).json({error:"Complete correctamente el título, la fecha y el horario."});
  if(compromisoPropio && !esOrientador(u)) return res.status(403).json({error:"Solo Orientación puede agendar compromisos propios desde esta opción."});
  if(compromisoPropio && participantes.length) return res.status(400).json({error:"Un compromiso propio no debe incluir invitados."});
  if(institucional && !esAdmin(u)) return res.status(403).json({error:"Solo Administración puede crear eventos institucionales."});
  if(participantes.length>100) return res.status(400).json({error:"Hay demasiadas personas invitadas."});
  const ids=[...new Set([u.id,...participantes])];
  const valid=await pool.query(`SELECT id,rol,nombre,primer_apellido FROM usuarios WHERE id=ANY($1::int[]) AND activo=true`,[ids]);
  if(valid.rows.length!==ids.length) return res.status(400).json({error:"Una de las personas seleccionadas no está disponible."});
  for(const p of valid.rows){
    const b=await bloqueExplicito(pool,p.id,anio,fecha,inicio,fin);
    if(b) return res.status(409).json({error:`${p.nombre} ${p.primer_apellido} tiene la hora bloqueada: ${b.motivo}.`});
    if(tipo==="orientacion" && (p.rol==="orientador")){
      const err=await validarOrientacion(pool,p.id,anio,fecha,inicio,fin); if(err)return res.status(409).json({error:err});
    }
    if(await compromisoExistente(pool,p.id,fecha,inicio,fin))return res.status(409).json({error:`${p.nombre} ${p.primer_apellido} ya tiene una cita o reunión en ese horario.`});
  }
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query(`INSERT INTO agenda_eventos(anio,titulo,tipo,fecha,hora_inicio,hora_fin,lugar,descripcion,creador_id,estudiante_id,institucional)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[anio,titulo,tipo,fecha,inicio,fin,limpio(req.body.lugar).slice(0,250),limpio(req.body.descripcion).slice(0,2000),u.id,Number(req.body.estudiante_id)||null,institucional]);
    for(const id of ids){
      await client.query(`INSERT INTO agenda_participantes(evento_id,usuario_id,estado,responded_at)
        VALUES($1,$2,$3,CASE WHEN $3='aceptado' THEN NOW() END)`,[r.rows[0].id,id,id===u.id?'aceptado':'pendiente']);
      if(id!==u.id) await notificar(client,id,`📅 Invitación pendiente: ${titulo}, ${fechaTexto(fecha)} de ${inicio} a ${fin}.`,r.rows[0].id);
    }
    await client.query("COMMIT"); res.json({ok:true,id:r.rows[0].id});
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
});

router.put("/eventos/:id/responder", async (req,res)=>{
  const uid=req.session.usuario.id, accion=limpio(req.body.accion);
  const estado={aceptar:"aceptado",rechazar:"rechazado",proponer:"propuesto"}[accion];
  if(!estado)return res.status(400).json({error:"Respuesta inválida."});
  const q=await pool.query(`SELECT e.*,ap.id participante_id FROM agenda_eventos e JOIN agenda_participantes ap ON ap.evento_id=e.id
    WHERE e.id=$1 AND ap.usuario_id=$2 AND e.estado='activo'`,[req.params.id,uid]);
  if(!q.rows.length)return res.status(404).json({error:"Invitación no encontrada."});
  let pf=null,pi=null,pfn=null;
  if(accion==="proponer"){
    pf=limpio(req.body.fecha);pi=limpio(req.body.hora_inicio).slice(0,5);pfn=limpio(req.body.hora_fin).slice(0,5);
    if(!fechaOk(pf)||!horaOk(pi)||!horaOk(pfn)||pfn<=pi)return res.status(400).json({error:"Indique una propuesta válida."});
    const b=await bloqueExplicito(pool,uid,q.rows[0].anio,pf,pi,pfn);
    if(b)return res.status(409).json({error:`La nueva hora está bloqueada: ${b.motivo}.`});
  }
  await pool.query(`UPDATE agenda_participantes SET estado=$1,respuesta=$2,propuesta_fecha=$3,propuesta_inicio=$4,propuesta_fin=$5,responded_at=NOW()
    WHERE id=$6`,[estado,limpio(req.body.mensaje).slice(0,700),pf,pi,pfn,q.rows[0].participante_id]);
  await notificar(pool,q.rows[0].creador_id,`📅 ${req.session.usuario.nombre} respondió “${estado}” a: ${q.rows[0].titulo}.`,q.rows[0].id);
  res.json({ok:true});
});

router.put("/eventos/:id/cancelar", async (req,res)=>{
  const q=await pool.query(`UPDATE agenda_eventos SET estado='cancelado',updated_at=NOW() WHERE id=$1 AND (creador_id=$2 OR $3::boolean=true) RETURNING id,titulo`,[req.params.id,req.session.usuario.id,esAdmin(req.session.usuario)]);
  if(!q.rows.length)return res.status(404).json({error:"Evento no encontrado o sin permiso."});
  const ps=await pool.query("SELECT usuario_id FROM agenda_participantes WHERE evento_id=$1 AND usuario_id<>$2",[req.params.id,req.session.usuario.id]);
  for(const p of ps.rows)await notificar(pool,p.usuario_id,`📅 Se canceló el evento: ${q.rows[0].titulo}.`,q.rows[0].id);
  res.json({ok:true});
});

router.get("/configuracion", async (req,res)=>{
  if(req.session.usuario.rol!=="admin")return res.status(403).json({error:"Solo el administrador puede configurar la jornada de Orientación."});
  const anio=await obtenerAnioActivo(); let uid=req.session.usuario.id;
  if(req.query.usuario_id && esAdmin(req.session.usuario))uid=Number(req.query.usuario_id);
  const [h,b]=await Promise.all([
    pool.query(`SELECT dia_semana,hora_inicio::text,hora_fin::text FROM agenda_horarios_oficina WHERE usuario_id=$1 AND anio=$2 AND activo=true ORDER BY dia_semana`,[uid,anio]),
    pool.query(`SELECT id,fecha::text,dia_semana,hora_inicio::text,hora_fin::text,motivo FROM agenda_bloqueos WHERE usuario_id=$1 AND anio=$2 AND activo=true ORDER BY dia_semana,fecha,hora_inicio`,[uid,anio])
  ]); res.json({usuario_id:uid,horarios:h.rows,bloqueos:b.rows});
});

router.put("/horario-oficina", async (req,res)=>{
  if(req.session.usuario.rol!=="admin")return res.status(403).json({error:"Solo el administrador puede asignar el horario laboral de Orientación."});
  const uid=Number(req.body.usuario_id);
  const target=await pool.query("SELECT id,rol FROM usuarios WHERE id=$1 AND activo=true",[uid]);
  if(!target.rows.length || target.rows[0].rol!=="orientador")return res.status(400).json({error:"El horario de oficina corresponde a una orientadora activa."});
  const horarios=Array.isArray(req.body.horarios)?req.body.horarios:[], anio=await obtenerAnioActivo();
  for(const h of horarios)if(Number(h.dia_semana)<1||Number(h.dia_semana)>5||!horaOk(h.hora_inicio)||!horaOk(h.hora_fin)||h.hora_fin<=h.hora_inicio)return res.status(400).json({error:"Hay un horario de oficina inválido."});
  const pausas=await pool.query(`SELECT dia_semana,hora_inicio::text,hora_fin::text,motivo FROM agenda_bloqueos
    WHERE usuario_id=$1 AND anio=$2 AND activo=true AND fecha IS NULL`,[uid,anio]);
  for(const p of pausas.rows){
    const jornada=horarios.find(h=>Number(h.dia_semana)===Number(p.dia_semana));
    if(!jornada || p.hora_inicio.slice(0,5)<jornada.hora_inicio || p.hora_fin.slice(0,5)>jornada.hora_fin)
      return res.status(409).json({error:`La pausa de ${p.motivo} del día ${p.dia_semana} quedaría fuera de la nueva jornada. Ajuste o elimine primero esa pausa.`});
  }
  const c=await pool.connect();try{await c.query("BEGIN");await c.query("DELETE FROM agenda_horarios_oficina WHERE usuario_id=$1 AND anio=$2",[uid,anio]);for(const h of horarios)await c.query(`INSERT INTO agenda_horarios_oficina(usuario_id,anio,dia_semana,hora_inicio,hora_fin) VALUES($1,$2,$3,$4,$5)`,[uid,anio,Number(h.dia_semana),h.hora_inicio,h.hora_fin]);await c.query("COMMIT");res.json({ok:true});}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
});

router.post("/bloqueos", async (req,res)=>{
  if(req.session.usuario.rol!=="admin")return res.status(403).json({error:"Solo el administrador puede asignar las pausas de Orientación."});
  const uid=Number(req.body.usuario_id),dia=Number(req.body.dia_semana)||null,inicio=limpio(req.body.hora_inicio).slice(0,5),fin=limpio(req.body.hora_fin).slice(0,5),tipo=limpio(req.body.tipo_pausa);
  if(!uid||!dia||dia<1||dia>5||!horaOk(inicio)||!horaOk(fin)||fin<=inicio||!["Desayuno","Almuerzo"].includes(tipo))return res.status(400).json({error:"Indique orientadora, día, tipo de pausa y horario."});
  const orientadora=await pool.query("SELECT id FROM usuarios WHERE id=$1 AND rol='orientador' AND activo=true",[uid]);
  if(!orientadora.rows.length)return res.status(400).json({error:"Seleccione una orientadora activa."});
  const anio=await obtenerAnioActivo();
  const jornada=await pool.query(`SELECT hora_inicio::text,hora_fin::text FROM agenda_horarios_oficina
    WHERE usuario_id=$1 AND anio=$2 AND dia_semana=$3 AND activo=true`,[uid,anio,dia]);
  if(!jornada.rows.length)return res.status(409).json({error:"Primero asigne la jornada laboral de ese día."});
  if(inicio<jornada.rows[0].hora_inicio.slice(0,5)||fin>jornada.rows[0].hora_fin.slice(0,5))return res.status(409).json({error:"La pausa debe quedar dentro de la jornada laboral."});
  const cruce=await pool.query(`SELECT motivo FROM agenda_bloqueos WHERE usuario_id=$1 AND anio=$2 AND activo=true
    AND fecha IS NULL AND dia_semana=$3 AND hora_inicio<$5::time AND hora_fin>$4::time LIMIT 1`,[uid,anio,dia,inicio,fin]);
  if(cruce.rows.length)return res.status(409).json({error:`La pausa se cruza con ${cruce.rows[0].motivo}.`});
  const r=await pool.query(`INSERT INTO agenda_bloqueos(usuario_id,anio,fecha,dia_semana,hora_inicio,hora_fin,motivo,creado_por) VALUES($1,$2,NULL,$3,$4,$5,$6,$7) RETURNING id`,[uid,anio,dia,inicio,fin,tipo,req.session.usuario.id]);res.json({ok:true,id:r.rows[0].id});
});

router.delete("/bloqueos/:id", async (req,res)=>{
  if(req.session.usuario.rol!=="admin")return res.status(403).json({error:"Solo el administrador puede modificar las pausas de Orientación."});
  const q=await pool.query(`UPDATE agenda_bloqueos SET activo=false WHERE id=$1 RETURNING id`,[req.params.id]);
  if(!q.rows.length)return res.status(404).json({error:"Bloqueo no encontrado."});res.json({ok:true});
});

module.exports=router;

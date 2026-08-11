const router = require("express").Router();
const { pool } = require("../db");
const { requireDocente } = require("../middleware/auth");
const { fechaCR, obtenerAnioActivo, obtenerPeriodoActual } = require("../utils/lectivo");
const { notificarCedula } = require("../utils/push-familias");

function horaCR(){
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Costa_Rica", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

function limpiarCedula(c){ return String(c || "").replace(/[\s\-.\/\\]/g, ""); }
function horaValida(h){ return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || "").slice(0,5)); }
function fechaValida(f){ return /^\d{4}-\d{2}-\d{2}$/.test(String(f || "")); }
function fechaTexto(f){ const [y,m,d]=String(f||"").slice(0,10).split("-"); return d&&m&&y?`${d}/${m}/${y}`:String(f||""); }

function validarMomento(fecha, hora){
  if(!fechaValida(fecha) || !horaValida(hora)) return "Fecha u hora inválida.";
  const hoy = fechaCR();
  if(fecha < hoy || (fecha === hoy && hora <= horaCR())) return "La cita debe ser en una fecha y hora futuras.";
  const limite = new Date(`${hoy}T12:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() + 180);
  if(fecha > limite.toISOString().slice(0,10)) return "La cita no puede programarse con más de 180 días de anticipación.";
  return null;
}

async function notificar(usuarioId, mensaje, referenciaId){
  if(!usuarioId) return;
  await pool.query(
    "INSERT INTO notificaciones(usuario_id,tipo,mensaje,referencia_id) VALUES($1,'cita',$2,$3)",
    [usuarioId, mensaje, referenciaId]
  ).catch(()=>{});
}

async function asignacionDelDocente(profesorId, estudianteId, asignacionId = null){
  const anio = await obtenerAnioActivo();
  const params = [profesorId, estudianteId, anio];
  let extra = "";
  if(asignacionId){ params.push(asignacionId); extra = ` AND a.id=$${params.length}`; }
  const r = await pool.query(`
    SELECT a.id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo,
      m.nombre AS materia_nombre
    FROM asignaciones a
    JOIN estudiantes e ON e.seccion_id=a.seccion_id
    JOIN materias m ON m.id=a.materia_id
    WHERE a.profesor_id=$1 AND e.id=$2 AND COALESCE(a.anio,$3)=$3
      AND COALESCE(a.activa,true)=true
      AND (COALESCE(a.subgrupo,'')='' OR UPPER(a.subgrupo)=UPPER(COALESCE(e.subgrupo,'')))
      ${extra}
    ORDER BY a.id DESC LIMIT 1
  `, params);
  return r.rows[0] || null;
}

async function hayChoqueCita(db, profesorId, estudianteId, fecha, hora, duracion, excluirId=null){
  const r = await db.query(`
    SELECT id FROM citas
    WHERE fecha=$3 AND estado IN ('pendiente','confirmada')
      AND (profesor_id=$1 OR estudiante_id=$2)
      AND ($6::int IS NULL OR id<>$6)
      AND hora < ($4::time + make_interval(mins=>$5::int))
      AND (hora + make_interval(mins=>duracion_min)) > $4::time
    LIMIT 1
  `, [profesorId, estudianteId, fecha, hora, duracion, excluirId]);
  return r.rows.length > 0;
}

// Estudiantes a quienes el docente realmente imparte alguna materia este año.
router.get("/estudiantes", requireDocente, async (req, res) => {
  const profesorId = req.session.usuario.id;
  const anio = await obtenerAnioActivo();
  const periodo = (await obtenerPeriodoActual()).nombre;
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      s.nombre AS seccion_nombre,
      STRING_AGG(DISTINCT m.nombre, ', ' ORDER BY m.nombre) AS materias
    FROM asignaciones a
    JOIN estudiantes e ON e.seccion_id=a.seccion_id
    JOIN secciones s ON s.id=e.seccion_id
    JOIN materias m ON m.id=a.materia_id
    WHERE a.profesor_id=$1 AND COALESCE(a.anio,$2)=$2
      AND COALESCE(a.activa,true)=true
      AND COALESCE(a.periodo,'I Período') IN ('I Período',$3)
      AND e.activo=true AND COALESCE(e.archivado,false)=false
      AND (COALESCE(a.subgrupo,'')='' OR UPPER(a.subgrupo)=UPPER(COALESCE(e.subgrupo,'')))
    GROUP BY e.id, s.nombre
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
  `, [profesorId, anio, periodo]);
  res.json(r.rows);
});

router.get("/disponibilidad", requireDocente, async (req, res) => {
  const anio = await obtenerAnioActivo();
  const r = await pool.query(`
    SELECT id, dia_semana, hora_inicio::text, hora_fin::text, duracion_min, activa
    FROM citas_disponibilidad
    WHERE profesor_id=$1 AND anio=$2 AND activa=true
    ORDER BY dia_semana, hora_inicio
  `, [req.session.usuario.id, anio]);
  res.json({ anio, bloques: r.rows });
});

router.put("/disponibilidad", requireDocente, async (req, res) => {
  const bloques = Array.isArray(req.body.bloques) ? req.body.bloques : [];
  if(bloques.length > 25) return res.status(400).json({ error: "Puede guardar como máximo 25 bloques de disponibilidad." });
  for(const b of bloques){
    const dia = Number(b.dia_semana), duracion = Number(b.duracion_min || 20);
    if(dia < 1 || dia > 5 || !horaValida(b.hora_inicio) || !horaValida(b.hora_fin) || b.hora_fin <= b.hora_inicio)
      return res.status(400).json({ error: "Hay un bloque con día u horas inválidas." });
    if(duracion < 10 || duracion > 120)
      return res.status(400).json({ error: "La duración debe estar entre 10 y 120 minutos." });
  }
  for(let i=0;i<bloques.length;i++) for(let j=i+1;j<bloques.length;j++){
    const a=bloques[i], b=bloques[j];
    if(Number(a.dia_semana)===Number(b.dia_semana)
      && String(a.hora_inicio).slice(0,5)<String(b.hora_fin).slice(0,5)
      && String(b.hora_inicio).slice(0,5)<String(a.hora_fin).slice(0,5))
      return res.status(400).json({ error:"Hay dos bloques de disponibilidad que se traslapan el mismo día." });
  }
  const profesorId = req.session.usuario.id;
  const anio = await obtenerAnioActivo();
  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("DELETE FROM citas_disponibilidad WHERE profesor_id=$1 AND anio=$2", [profesorId, anio]);
    for(const b of bloques){
      await client.query(`
        INSERT INTO citas_disponibilidad(profesor_id,anio,dia_semana,hora_inicio,hora_fin,duracion_min)
        VALUES($1,$2,$3,$4,$5,$6)
      `, [profesorId, anio, Number(b.dia_semana), String(b.hora_inicio).slice(0,5), String(b.hora_fin).slice(0,5), Number(b.duracion_min || 20)]);
    }
    await client.query("COMMIT");
    res.json({ ok:true, anio, total:bloques.length });
  }catch(e){
    await client.query("ROLLBACK");
    if(e.code === "23505") return res.status(400).json({ error:"No repita dos bloques que comienzan el mismo día y hora." });
    throw e;
  }finally{ client.release(); }
});

router.get("/mis-citas", requireDocente, async (req, res) => {
  const anio = await obtenerAnioActivo();
  const r = await pool.query(`
    SELECT c.id, c.anio, c.fecha::text, c.hora::text, c.duracion_min, c.motivo,
      c.estado, c.pendiente_de, c.solicitada_por, c.es_contrapropuesta,
      c.respuesta_mensaje, c.created_at,
      e.id AS estudiante_id, e.nombre AS est_nombre, e.primer_apellido AS est_ap1,
      e.segundo_apellido AS est_ap2, s.nombre AS seccion_nombre,
      m.nombre AS materia_nombre,
      enc.nombre AS enc_nombre, enc.primer_apellido AS enc_ap1, enc.segundo_apellido AS enc_ap2
    FROM citas c
    JOIN estudiantes e ON e.id=c.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN asignaciones a ON a.id=c.asignacion_id
    LEFT JOIN materias m ON m.id=a.materia_id
    LEFT JOIN LATERAL (
      SELECT nombre, primer_apellido, segundo_apellido FROM encargados x
      WHERE x.estudiante_id=e.id
        AND REPLACE(REPLACE(REPLACE(x.cedula,'-',''),'.',''),' ','')=c.encargado_cedula
      ORDER BY x.es_principal DESC, x.id LIMIT 1
    ) enc ON true
    WHERE c.profesor_id=$1 AND c.anio=$2
    ORDER BY CASE WHEN c.estado='pendiente' THEN 0 WHEN c.estado='confirmada' THEN 1 ELSE 2 END,
      c.fecha, c.hora
  `, [req.session.usuario.id, anio]);
  res.json(r.rows);
});

// El docente también puede proponer una cita. El encargado deberá confirmarla.
router.post("/solicitar", requireDocente, async (req, res) => {
  const profesorId = req.session.usuario.id;
  const estudianteId = Number(req.body.estudiante_id);
  const fecha = String(req.body.fecha || "");
  const hora = String(req.body.hora || "").slice(0,5);
  const motivo = String(req.body.motivo || "").trim();
  const errorMomento = validarMomento(fecha, hora);
  if(errorMomento) return res.status(400).json({ error:errorMomento });
  if(!estudianteId || motivo.length < 3) return res.status(400).json({ error:"Seleccione al estudiante e indique el motivo de la cita." });
  const asig = await asignacionDelDocente(profesorId, estudianteId, req.body.asignacion_id || null);
  if(!asig) return res.status(403).json({ error:"Solo puede solicitar citas con estudiantes a quienes imparte clases." });
  const encR = await pool.query(`
    SELECT cedula FROM encargados WHERE estudiante_id=$1 AND COALESCE(cedula,'')<>''
      AND COALESCE(es_principal,false)=true
    ORDER BY es_principal DESC, id LIMIT 1
  `, [estudianteId]);
  if(!encR.rows.length) return res.status(400).json({ error:"El estudiante no tiene un encargado con cédula registrada." });
  const cedula = limpiarCedula(encR.rows[0].cedula);
  const anio = await obtenerAnioActivo();
  const duracion = Number(req.body.duracion_min || 20);
  if(duracion < 10 || duracion > 120) return res.status(400).json({ error:"Duración inválida." });
  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [profesorId, fecha]);
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [-estudianteId, fecha]);
    if(await hayChoqueCita(client, profesorId, estudianteId, fecha, hora, duracion)){
      await client.query("ROLLBACK");
      return res.status(409).json({ error:"La hora se cruza con otra cita del docente o del estudiante." });
    }
    const r = await client.query(`
      INSERT INTO citas(anio,estudiante_id,profesor_id,asignacion_id,encargado_cedula,
        solicitada_por,fecha,hora,duracion_min,motivo,estado,pendiente_de,creada_por_usuario_id)
      VALUES($1,$2,$3,$4,$5,'profesor',$6,$7,$8,$9,'pendiente','encargado',$3)
      RETURNING id
    `, [anio, estudianteId, profesorId, asig.id, cedula, fecha, hora, duracion, motivo]);
    await client.query("COMMIT");
    await notificarCedula(cedula, {
      title:"📅 Nueva solicitud de cita",
      body:`Un docente propuso una cita para el ${fechaTexto(fecha)} a las ${hora}. Su confirmación está pendiente.`,
      url:"/?app=familias&abrir=citas",
      tag:`cita-pendiente-${r.rows[0].id}`,
      urgency:"high",
    });
    res.json({ ok:true, id:r.rows[0].id });
  }catch(e){
    await client.query("ROLLBACK").catch(()=>{});
    if(e.code === "23505") return res.status(409).json({ error:"Ya existe otra cita del docente en esa fecha y hora." });
    throw e;
  }finally{ client.release(); }
});

router.put("/:id/responder", requireDocente, async (req, res) => {
  const profesorId = req.session.usuario.id;
  const accion = String(req.body.accion || "");
  if(!["confirmar","rechazar","proponer"].includes(accion)) return res.status(400).json({ error:"Respuesta inválida." });
  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    const q = await client.query("SELECT * FROM citas WHERE id=$1 AND profesor_id=$2 FOR UPDATE", [req.params.id, profesorId]);
    if(!q.rows.length){ await client.query("ROLLBACK"); return res.status(404).json({ error:"Cita no encontrada." }); }
    const cita = q.rows[0];
    if(cita.estado !== "pendiente" || cita.pendiente_de !== "profesor"){
      await client.query("ROLLBACK");
      return res.status(400).json({ error:"Esta cita ya no está pendiente de respuesta del docente." });
    }
    const mensaje = String(req.body.mensaje || "").trim();
    if(accion === "confirmar"){
      await client.query("UPDATE citas SET estado='confirmada',pendiente_de=NULL,respuesta_mensaje=$1,updated_at=NOW() WHERE id=$2", [mensaje, cita.id]);
    }else if(accion === "rechazar"){
      await client.query("UPDATE citas SET estado='rechazada',pendiente_de=NULL,respuesta_mensaje=$1,updated_at=NOW() WHERE id=$2", [mensaje, cita.id]);
    }else{
      const fecha = String(req.body.fecha || ""), hora = String(req.body.hora || "").slice(0,5);
      const err = validarMomento(fecha, hora);
      if(err){ await client.query("ROLLBACK"); return res.status(400).json({ error:err }); }
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [profesorId, fecha]);
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [-cita.estudiante_id, fecha]);
      if(await hayChoqueCita(client, profesorId, cita.estudiante_id, fecha, hora, Number(cita.duracion_min), cita.id)){
        await client.query("ROLLBACK"); return res.status(409).json({ error:"La hora se cruza con otra cita." });
      }
      await client.query(`UPDATE citas SET fecha=$1,hora=$2,estado='pendiente',pendiente_de='encargado',
        es_contrapropuesta=true,respuesta_mensaje=$3,updated_at=NOW() WHERE id=$4`, [fecha, hora, mensaje, cita.id]);
    }
    await client.query("COMMIT");
    const estadoAviso=accion==="confirmar"?"confirmó":accion==="rechazar"?"rechazó":"propuso otra fecha para";
    await notificarCedula(cita.encargado_cedula, {
      title:"Respuesta a solicitud de cita",
      body:`El docente ${estadoAviso} la cita. Ingrese al portal para revisar los detalles.`,
      url:"/?app=familias&abrir=citas",
      tag:`cita-respuesta-${cita.id}-${Date.now()}`,
      urgency:"high",
    });
    res.json({ ok:true });
  }catch(e){
    await client.query("ROLLBACK");
    if(e.code === "23505") return res.status(409).json({ error:"Ya existe otra cita del docente en esa fecha y hora." });
    throw e;
  }finally{ client.release(); }
});

router.put("/:id/cancelar", requireDocente, async (req, res) => {
  const r = await pool.query(`UPDATE citas SET estado='cancelada',pendiente_de=NULL,
    respuesta_mensaje=$1,updated_at=NOW()
    WHERE id=$2 AND profesor_id=$3 AND estado IN ('pendiente','confirmada') RETURNING id,encargado_cedula`,
    [String(req.body.mensaje || "").trim(), req.params.id, req.session.usuario.id]);
  if(!r.rows.length) return res.status(404).json({ error:"La cita no existe o ya no puede cancelarse." });
  await notificarCedula(r.rows[0].encargado_cedula, {
    title:"Cita cancelada",
    body:"El docente canceló una cita pendiente o confirmada. Ingrese al portal para revisar la información.",
    url:"/?app=familias&abrir=citas",
    tag:`cita-cancelada-${r.rows[0].id}`,
    urgency:"high",
  });
  res.json({ ok:true });
});

module.exports = router;

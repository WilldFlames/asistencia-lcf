const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { obtenerAnioActivo, obtenerCalendario, obtenerRangoPeriodo } = require("../utils/lectivo");
const { obtenerLecciones } = require("./horarios");

async function canAccess(req, res, next) {
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error:"No autorizado" });
  if(["admin","auxiliar","administrativo"].includes(u.rol)) return next();
  try {
    const r = await pool.query("SELECT 1 FROM matricula_comite WHERE usuario_id=$1", [u.id]);
    if(r.rows.length) return next();
  } catch(e) { console.error("canAccess matricula:", e.message); }
  return res.status(403).json({ error:"Sin permisos" });
}

// ── LISTAR MATRÍCULAS ─────────────────────────────────────────────────
router.get("/", canAccess, async (req, res) => {
  const anioActivo = await obtenerAnioActivo();
  const anio = parseInt(req.query.anio) || anioActivo;
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.tipo_ingreso, e.nivel_matricula,
      COALESCE(ma.completada, CASE WHEN $2 THEN e.matricula_completada ELSE false END) AS matricula_completada,
      COALESCE(ma.estado, CASE WHEN $2 AND e.matricula_completada THEN 'completa' ELSE 'pendiente' END) AS matricula_estado,
      COALESCE(ma.convocatoria,false) AS convocatoria,
      ma.convocatoria_estado, ma.nivel_solicitado, ma.nivel_origen,
      ma.convocatoria_resuelta_at,
      e.idioma, e.tecnologia,
      e.boleta_entregada,
      e.seccion_id, s.nombre AS seccion_nombre, e.created_at
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN matricula ma ON ma.estudiante_id=e.id AND ma.anio=$1
    WHERE e.activo=true AND (e.archivado=false OR e.archivado IS NULL)
    ORDER BY e.primer_apellido, e.nombre
  `, [anio, anio === anioActivo]);
  res.json(r.rows);
});

// ── CARGAR POR CÉDULA (busca en estudiantes y prematrícula) ──────────
router.get("/cedula/:cedula", canAccess, async (req, res) => {
  const cedula = req.params.cedula.trim();
  const anio = parseInt(req.query.anio) || await obtenerAnioActivo();

  // 1. Buscar en estudiantes activos
  const r = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre,
      COALESCE(ma.convocatoria,false) AS convocatoria,
      ma.convocatoria_estado, ma.nivel_solicitado, ma.nivel_origen,
      ma.estado AS matricula_estado_anual
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN matricula ma ON ma.estudiante_id=e.id AND ma.anio=$2
    WHERE e.cedula=$1 AND e.activo=true
  `, [cedula, anio]);

  if(r.rows.length){
    const encs = await pool.query(
      "SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC",
      [r.rows[0].id]
    );
    return res.json({ fuente:"estudiante", ...r.rows[0], encargados: encs.rows });
  }

  // 2. Buscar en prematrícula
  try {
    const p = await pool.query(`
      SELECT pm.*,
        pe.parentesco, pe.cedula AS enc_cedula,
        pe.nombre AS enc_nombre, pe.primer_apellido AS enc_ap1,
        pe.segundo_apellido AS enc_ap2, pe.nacionalidad AS enc_nacionalidad,
        pe.fecha_nacimiento AS enc_fecha_nac
      FROM prematricula pm
      LEFT JOIN prematricula_encargado pe ON pe.prematricula_id=pm.id
      WHERE pm.cedula=$1
    `, [cedula]);
    if(p.rows.length) return res.json({ fuente:"prematricula", ...p.rows[0] });
  } catch(e) { console.error("matricula GET /cedula prematricula:", e.message); }

  return res.json(null);
});

// ── GUARDAR DATOS DEL ESTUDIANTE (Paso 1) ────────────────────────────
router.post("/guardar", canAccess, async (req, res) => {
  try {
  const {
    cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento,
    sexo, nacionalidad, correo, institucion_procedencia,
    provincia, canton, distrito, direccion_exacta,
    habita_con, habita_con_otro, adecuacion, tipo_ingreso, nivel_matricula,
    enfermedad, medicamento, telefonos_emergencia, encargados
  } = req.body;

  if(!cedula||!nombre||!primer_apellido)
    return res.status(400).json({ error:"Datos incompletos." });

  const uid = req.session.usuario.id;
  
  // Verificar que las columnas nuevas existen (pueden no existir en DB antigua)
  try {
    await pool.query("SELECT sexo, correo, provincia, canton, distrito, direccion_exacta, habita_con, habita_con_otro, adecuacion, tipo_ingreso, nivel_matricula, institucion_procedencia, enfermedad, medicamento, telefonos_emergencia FROM estudiantes LIMIT 0");
  } catch(colErr) {
    return res.status(500).json({ error: "Columnas de matrícula no encontradas en BD. Reiniciá el servidor para aplicar la migración." });
  }

  const existe = await pool.query("SELECT id FROM estudiantes WHERE cedula=$1", [cedula]);
  let estId;

  if(existe.rows.length){
    estId = existe.rows[0].id;
    await pool.query(`
      UPDATE estudiantes SET
        nombre=$1, primer_apellido=$2, segundo_apellido=$3, fecha_nacimiento=$4,
        sexo=$5, nacionalidad=$6, correo=$7, institucion_procedencia=$8,
        provincia=$9, canton=$10, distrito=$11, direccion_exacta=$12,
        habita_con=$13, habita_con_otro=$14, adecuacion=$15, tipo_ingreso=$16,
        nivel_matricula=$17, enfermedad=$18, medicamento=$19,
        telefonos_emergencia=$20, activo=true
      WHERE id=$21
    `, [nombre, primer_apellido, segundo_apellido, fecha_nacimiento||null,
        sexo||null, nacionalidad||null, correo||null, institucion_procedencia||null,
        provincia||null, canton||null, distrito||null, direccion_exacta||null,
        habita_con||null, habita_con_otro||null, adecuacion||'ninguna',
        tipo_ingreso||'regular', nivel_matricula||null,
        enfermedad||null, medicamento||null, telefonos_emergencia||null, estId]);
  } else {
    const r = await pool.query(`
      INSERT INTO estudiantes
        (cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento,
         sexo, nacionalidad, correo, institucion_procedencia,
         provincia, canton, distrito, direccion_exacta,
         habita_con, habita_con_otro, adecuacion, tipo_ingreso, nivel_matricula,
         enfermedad, medicamento, telefonos_emergencia, activo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true)
      RETURNING id
    `, [cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento||null,
        sexo||null, nacionalidad||null, correo||null, institucion_procedencia||null,
        provincia||null, canton||null, distrito||null, direccion_exacta||null,
        habita_con||null, habita_con_otro||null, adecuacion||'ninguna',
        tipo_ingreso||'regular', nivel_matricula||null,
        enfermedad||null, medicamento||null, telefonos_emergencia||null]);
    estId = r.rows[0].id;
  }

  // Guardar encargados
  if(Array.isArray(encargados) && encargados.length){
    await pool.query("DELETE FROM encargados WHERE estudiante_id=$1", [estId]);
    for(let i=0; i<encargados.length; i++){
      const e = encargados[i];
      if(!e.nombre) continue;
      await pool.query(`
        INSERT INTO encargados
          (estudiante_id, parentesco, cedula, nombre, primer_apellido,
           segundo_apellido, nacionalidad, profesion, lugar_trabajo,
           telefono, celular, telefono_trabajo, email, es_principal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [estId, e.parentesco||null, e.cedula||null, e.nombre||null, e.primer_apellido||null,
          e.segundo_apellido||null, e.nacionalidad||null, e.profesion||null, e.lugar_trabajo||null,
          e.telefono||null, e.celular||null, e.telefono_trabajo||null, e.email||null, i===0]);
    }
  }

  // Marcar prematrícula como matriculado
  try {
    await pool.query(
      "UPDATE prematricula SET estado='matriculado' WHERE cedula=$1",
      [cedula]
    );
  } catch(e) { console.error("matricula UPDATE prematricula matriculado:", e.message); }

  res.json({ ok:true, estudiante_id: estId });
  } catch(err) {
    console.error('guardar matricula error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GUARDAR BECA COMEDOR ──────────────────────────────────────────────
router.post("/beca-comedor", canAccess, async (req, res) => {
  const { estudiante_id, cedula_estudiante, personas_hogar, tipo_vivienda,
          vive_con, ingreso_mensual, recibe_avancemos, monto_avancemos,
          otros_ingresos, motivos } = req.body;

  const ingreso   = parseFloat(ingreso_mensual)||0;
  const personas  = parseInt(personas_hogar)||1;
  const percapita = personas > 0 ? ingreso/personas : ingreso;

  let clasificacion, resolucion;
  if(percapita < 100000){
    clasificacion="Alta vulnerabilidad";   resolucion="aprobado";
  } else if(percapita <= 180000){
    clasificacion="Vulnerabilidad media";  resolucion="aprobado";
  } else if(percapita <= 300000){
    clasificacion="Vulnerabilidad baja";   resolucion="pendiente";
  } else {
    clasificacion="Fuera de prioridad";    resolucion="pendiente";
  }

  try {
    await pool.query(`
      INSERT INTO solicitud_beca_comedor
        (estudiante_id, cedula_estudiante, personas_hogar, tipo_vivienda, vive_con,
         ingreso_mensual, recibe_avancemos, monto_avancemos, otros_ingresos, motivos,
         ingreso_percapita, clasificacion, resolucion, registrado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [estudiante_id||null, cedula_estudiante||null, personas, tipo_vivienda||null,
        vive_con||null, ingreso, recibe_avancemos||false, monto_avancemos||0,
        otros_ingresos||null, motivos||null, percapita, clasificacion,
        resolucion, req.session.usuario.id]);
  } catch(e) {
    console.error('beca-comedor INSERT error:', e.message);
    return res.status(500).json({ error: "No se pudo guardar la solicitud: " + e.message });
  }

  // Sincronizar el campo `becado` del estudiante con la resolución actual:
  // aprobado → becado=true; pendiente o rechazado → becado=false
  // (antes solo marcaba a true; si la situación cambiaba, la beca quedaba pegada)
  if(estudiante_id){
    try {
      await pool.query("UPDATE estudiantes SET becado=$1 WHERE id=$2",
        [resolucion === "aprobado", estudiante_id]);
    } catch(e){ console.error('beca-comedor UPDATE estudiante:', e.message); }
  }

  res.json({ ok:true, percapita, clasificacion, resolucion });
});

// ── GUARDAR ADECUACIÓN ────────────────────────────────────────────────
router.post("/adecuacion", canAccess, async (req, res) => {
  const { estudiante_id, motivo, antecedentes } = req.body;
  try {
    await pool.query(`
      INSERT INTO solicitud_adecuacion (estudiante_id, motivo, antecedentes, registrado_por)
      VALUES ($1,$2,$3,$4)
    `, [estudiante_id||null, motivo||null, antecedentes||null, req.session.usuario.id]);
    if(estudiante_id)
      await pool.query("UPDATE estudiantes SET adecuacion='significativa' WHERE id=$1", [estudiante_id]);
  } catch(e) {
    console.error('adecuacion error:', e.message);
    return res.status(500).json({ error: "No se pudo guardar la solicitud: " + e.message });
  }
  res.json({ ok:true });
});

// ── COMPLETAR MATRÍCULA ───────────────────────────────────────────────
router.post("/completar/:id", canAccess, async (req, res) => {
  const anioActivo = await obtenerAnioActivo();
  const anio = parseInt(req.body?.anio || req.query.anio) || anioActivo;
  const convocatoria = req.body?.convocatoria === true;
  const nivelSolicitado = parseInt(req.body?.nivel_solicitado) || null;
  const uid = req.session.usuario.id;
  if(convocatoria){
    const est = await pool.query(`SELECT e.id,e.nivel_matricula,s.nivel AS nivel_actual
      FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id WHERE e.id=$1`, [req.params.id]);
    if(!est.rows.length) return res.status(404).json({ error:"Estudiante no encontrado." });
    const nivelDestino = nivelSolicitado || parseInt(est.rows[0].nivel_matricula) || null;
    if(!nivelDestino) return res.status(400).json({ error:"Indique el nivel que cursaría si aprueba la convocatoria." });
    const nivelOrigen = parseInt(est.rows[0].nivel_actual) || Math.max(7, nivelDestino - 1);
    await pool.query(`INSERT INTO matricula
      (estudiante_id,anio,seccion_id,seccion_nombre,completada,estado,confirmado_por,
       convocatoria,convocatoria_estado,nivel_solicitado,nivel_origen,
       convocatoria_resuelta_por,convocatoria_resuelta_at)
      VALUES ($1,$2,NULL,'',true,'convocatoria',$3,true,'pendiente',$4,$5,NULL,NULL)
      ON CONFLICT (estudiante_id,anio) DO UPDATE SET
        seccion_id=NULL,seccion_nombre='',completada=true,estado='convocatoria',confirmado_por=$3,
        convocatoria=true,convocatoria_estado='pendiente',nivel_solicitado=$4,nivel_origen=$5,
        convocatoria_resuelta_por=NULL,convocatoria_resuelta_at=NULL`,
      [req.params.id,anio,uid,nivelDestino,nivelOrigen]);
    if(anio === anioActivo)
      await pool.query("UPDATE estudiantes SET seccion_id=NULL,matricula_completada=false WHERE id=$1", [req.params.id]);
    return res.json({ ok:true, convocatoria:true, estado:"pendiente", nivel_solicitado:nivelDestino, nivel_origen:nivelOrigen });
  }
  await pool.query(`INSERT INTO matricula
    (estudiante_id,anio,completada,estado,confirmado_por,convocatoria,convocatoria_estado,nivel_solicitado,nivel_origen)
    VALUES ($1,$2,true,'completa',$3,false,NULL,$4,NULL)
    ON CONFLICT (estudiante_id,anio) DO UPDATE SET
      completada=true,
      estado=CASE WHEN matricula.convocatoria=true AND matricula.convocatoria_estado IN ('aprobado','reprobado')
        THEN matricula.estado ELSE 'completa' END,
      confirmado_por=$3,
      convocatoria=CASE WHEN matricula.convocatoria_estado IN ('aprobado','reprobado') THEN true ELSE false END,
      convocatoria_estado=CASE WHEN matricula.convocatoria_estado IN ('aprobado','reprobado')
        THEN matricula.convocatoria_estado ELSE NULL END,
      nivel_solicitado=COALESCE($4,matricula.nivel_solicitado),
      nivel_origen=CASE WHEN matricula.convocatoria_estado IN ('aprobado','reprobado')
        THEN matricula.nivel_origen ELSE NULL END`,
    [req.params.id,anio,uid,nivelSolicitado]);
  if(anio === anioActivo)
    await pool.query("UPDATE estudiantes SET matricula_completada=true WHERE id=$1", [req.params.id]);
  res.json({ ok:true, convocatoria:false });
});

// ── ELIMINAR MATRÍCULA (soft delete) ─────────────────────────────────
router.delete("/:id", canAccess, async (req, res) => {
  const { justificacion, anio } = req.body || {};
  if(!justificacion?.trim())
    return res.status(400).json({ error:"La justificación es obligatoria." });
  const r = await pool.query("SELECT id FROM estudiantes WHERE id=$1", [req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error:"No encontrado." });
  const anioActivo = await obtenerAnioActivo();
  const anioObjetivo = parseInt(anio) || anioActivo;
  if(anioObjetivo !== anioActivo){
    await pool.query("DELETE FROM matricula WHERE estudiante_id=$1 AND anio=$2", [req.params.id,anioObjetivo]);
    return res.json({ ok:true, matricula_anual_eliminada:true });
  }
  // Get cedula to revert prematricula
  const est = await pool.query("SELECT cedula FROM estudiantes WHERE id=$1", [req.params.id]);
  await pool.query("UPDATE estudiantes SET activo=false, matricula_completada=false WHERE id=$1", [req.params.id]);
  // Revertir estado de prematrícula si existe
  if(est.rows.length) {
    try {
      await pool.query(
        "UPDATE prematricula SET estado='pendiente' WHERE cedula=$1 AND estado='matriculado'",
        [est.rows[0].cedula]
      );
    } catch(e) { console.error("matricula UPDATE prematricula pendiente:", e.message); }
  }
  res.json({ ok:true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  MATRÍCULA CON SECCIÓN POR AÑO (cupos, idioma, tecnología)
// ═══════════════════════════════════════════════════════════════════════════

const MAX_CUPO = 26; // máximo de estudiantes por sección

// Fecha/año actual en Costa Rica (UTC-6)
function fechaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  return new Date(localMs).toISOString().slice(0,10);
}
async function anioActualCR(){ return obtenerAnioActivo(); }

// Las restricciones se guardan una sola vez por pareja y año. Internamente
// siempre se conserva primero el ID menor, por eso funcionan en ambos sentidos.
function normalizarPareja(estudianteA, estudianteB){
  const a = parseInt(estudianteA);
  const b = parseInt(estudianteB);
  return a < b ? [a,b] : [b,a];
}

async function listarRestricciones(anio, estudianteId = null){
  const activo = await obtenerAnioActivo();
  const esActual = Number(anio) === activo;
  const params = [Number(anio), esActual];
  let filtro = "";
  if(estudianteId){
    params.push(Number(estudianteId));
    filtro = "AND (r.estudiante_a_id=$3 OR r.estudiante_b_id=$3)";
  }
  const r = await pool.query(`
    SELECT r.id, r.anio, r.estudiante_a_id, r.estudiante_b_id, r.motivo,
      r.creada_at,
      ea.cedula AS estudiante_a_cedula,
      ea.nombre AS estudiante_a_nombre, ea.primer_apellido AS estudiante_a_ap1, ea.segundo_apellido AS estudiante_a_ap2,
      eb.cedula AS estudiante_b_cedula,
      eb.nombre AS estudiante_b_nombre, eb.primer_apellido AS estudiante_b_ap1, eb.segundo_apellido AS estudiante_b_ap2,
      CASE WHEN $2::boolean THEN ea.seccion_id ELSE ma.seccion_id END AS estudiante_a_seccion_id,
      CASE WHEN $2::boolean THEN eb.seccion_id ELSE mb.seccion_id END AS estudiante_b_seccion_id,
      sa.nombre AS estudiante_a_seccion,
      sb.nombre AS estudiante_b_seccion,
      (CASE WHEN $2::boolean THEN ea.seccion_id ELSE ma.seccion_id END IS NOT NULL
       AND CASE WHEN $2::boolean THEN ea.seccion_id ELSE ma.seccion_id END =
           CASE WHEN $2::boolean THEN eb.seccion_id ELSE mb.seccion_id END) AS conflicto_actual,
      TRIM(CONCAT_WS(' ', u.nombre, u.primer_apellido, u.segundo_apellido)) AS creada_por_nombre
    FROM restricciones_matricula r
    JOIN estudiantes ea ON ea.id=r.estudiante_a_id
    JOIN estudiantes eb ON eb.id=r.estudiante_b_id
    LEFT JOIN matricula ma ON ma.estudiante_id=ea.id AND ma.anio=r.anio
    LEFT JOIN matricula mb ON mb.estudiante_id=eb.id AND mb.anio=r.anio
    LEFT JOIN secciones sa ON sa.id=CASE WHEN $2::boolean THEN ea.seccion_id ELSE ma.seccion_id END
    LEFT JOIN secciones sb ON sb.id=CASE WHEN $2::boolean THEN eb.seccion_id ELSE mb.seccion_id END
    LEFT JOIN usuarios u ON u.id=r.creada_por
    WHERE r.anio=$1 AND r.activa=true ${filtro}
    ORDER BY ea.primer_apellido, ea.segundo_apellido, ea.nombre,
             eb.primer_apellido, eb.segundo_apellido, eb.nombre
  `, params);
  return r.rows;
}

// ── RESTRICCIONES DE CONVIVENCIA POR AÑO ─────────────────────────────
// Lista institucional, sin limitarla a los grupos del usuario. Se usa solo
// dentro del módulo autorizado de restricciones para poder relacionar a dos
// estudiantes de cualquier sección del colegio.
router.get("/restricciones-estudiantes/:anio", canAccess, async (req, res) => {
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error:"Año inválido" });
  const activo = await obtenerAnioActivo();
  const esActual = anio === activo;
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.subgrupo,
      CASE WHEN $2::boolean THEN e.seccion_id ELSE m.seccion_id END AS seccion_id,
      s.nombre AS seccion_nombre
    FROM estudiantes e
    LEFT JOIN matricula m ON m.estudiante_id=e.id AND m.anio=$1
    LEFT JOIN secciones s ON s.id=CASE WHEN $2::boolean THEN e.seccion_id ELSE m.seccion_id END
    WHERE e.activo=true AND COALESCE(e.archivado,false)=false
    ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre
  `, [anio, esActual]);
  res.json(r.rows);
});

router.get("/restricciones/:anio", canAccess, async (req, res) => {
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error:"Año inválido" });
  res.json(await listarRestricciones(anio, req.query.estudiante_id));
});

router.post("/restricciones", canAccess, async (req, res) => {
  const anio = parseInt(req.body.anio);
  const est1 = parseInt(req.body.estudiante_a_id);
  const est2 = parseInt(req.body.estudiante_b_id);
  const motivo = String(req.body.motivo || "").trim();
  if(!anio || !est1 || !est2) return res.status(400).json({ error:"Seleccione los dos estudiantes y el año." });
  if(est1 === est2) return res.status(400).json({ error:"Debe seleccionar dos estudiantes diferentes." });
  if(motivo.length < 5) return res.status(400).json({ error:"Escriba el motivo de la restricción." });
  if(motivo.length > 500) return res.status(400).json({ error:"El motivo no puede superar 500 caracteres." });
  const estudiantes = await pool.query(`SELECT id FROM estudiantes
    WHERE id=ANY($1::int[]) AND activo=true AND COALESCE(archivado,false)=false`, [[est1,est2]]);
  if(estudiantes.rows.length !== 2)
    return res.status(404).json({ error:"Uno de los estudiantes no existe o está archivado." });
  await pool.query("INSERT INTO anios_lectivos (anio,estado) VALUES ($1,'preparacion') ON CONFLICT (anio) DO NOTHING", [anio]);
  const [a,b] = normalizarPareja(est1,est2);
  const guardada = await pool.query(`
    INSERT INTO restricciones_matricula
      (anio,estudiante_a_id,estudiante_b_id,motivo,activa,creada_por,eliminada_por,eliminada_at)
    VALUES ($1,$2,$3,$4,true,$5,NULL,NULL)
    ON CONFLICT (anio,estudiante_a_id,estudiante_b_id) DO UPDATE SET
      motivo=EXCLUDED.motivo, activa=true, creada_por=EXCLUDED.creada_por,
      creada_at=NOW(), eliminada_por=NULL, eliminada_at=NULL
    RETURNING id
  `, [anio,a,b,motivo,req.session.usuario.id]);
  const fila = (await listarRestricciones(anio)).find(x=>x.id===guardada.rows[0].id);
  res.json({ ok:true, restriccion:fila, conflicto_actual:!!fila?.conflicto_actual });
});

router.delete("/restricciones/:id", canAccess, async (req, res) => {
  const r = await pool.query(`UPDATE restricciones_matricula
    SET activa=false,eliminada_por=$1,eliminada_at=NOW()
    WHERE id=$2 AND activa=true RETURNING id`, [req.session.usuario.id,req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error:"Restricción no encontrada." });
  res.json({ ok:true });
});

async function conflictosEnSeccion(estudianteId, anio, seccionId, esActual, db = pool){
  const r = await db.query(`
    WITH restringidos AS (
      SELECT CASE WHEN estudiante_a_id=$1 THEN estudiante_b_id ELSE estudiante_a_id END AS otro_id,
             motivo
      FROM restricciones_matricula
      WHERE anio=$2 AND activa=true AND (estudiante_a_id=$1 OR estudiante_b_id=$1)
    )
    SELECT rr.otro_id, rr.motivo, e.nombre, e.primer_apellido, e.segundo_apellido, s.nombre AS seccion_nombre
    FROM restringidos rr
    JOIN estudiantes e ON e.id=rr.otro_id AND e.activo=true AND COALESCE(e.archivado,false)=false
    LEFT JOIN matricula m ON m.estudiante_id=e.id AND m.anio=$2
    LEFT JOIN secciones s ON s.id=CASE WHEN $4::boolean THEN e.seccion_id ELSE m.seccion_id END
    WHERE CASE WHEN $4::boolean THEN e.seccion_id ELSE m.seccion_id END=$3
    ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre
  `, [estudianteId,anio,seccionId,esActual]);
  return r.rows;
}

// Subgrupo según tecnología:
//   Inglés Conversacional = A
//   Diseño Publicitario   = B
//   Matem/AMPROSA         = B (misma B — por sección se elige UNA de las dos B)
function subgrupoDeTecnologia(tec){
  if(!tec) return null;
  if(/conversacional/i.test(tec)) return 'A';
  if(/publicitario/i.test(tec)) return 'B';
  if(/amprosa|matem/i.test(tec)) return 'B';
  return null;
}

// ── CUPOS POR SECCIÓN PARA UN AÑO (con desglose por subgrupo A/B) ────────
// Año actual → cuenta estudiantes activos en cada sección.
// Año futuro → cuenta filas de matrícula de ese año.
// Cupo máximo total: 26 · Máximo por subgrupo (A o B): 13
router.get("/cupos/:anio", canAccess, async (req, res) => {
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error: "Año inválido" });
  const esActual = anio === await anioActualCR();
  const q = esActual ? `
    SELECT s.id AS seccion_id, s.nombre, s.nivel, si.idioma, sc.tec_b,
      COUNT(e.id)::int AS ocupados,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(e.subgrupo,'')) = 'A')::int AS ocupados_a,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(e.subgrupo,'')) = 'B')::int AS ocupados_b
    FROM secciones s
    JOIN secciones_anio san ON san.seccion_id=s.id AND san.anio=$1 AND san.activa=true
    LEFT JOIN secciones_idioma si ON si.seccion_id = s.id AND si.anio = $1
    LEFT JOIN secciones_config sc ON sc.seccion_id = s.id AND sc.anio = $1
    LEFT JOIN estudiantes e ON e.seccion_id = s.id
      AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
    GROUP BY s.id, si.idioma, sc.tec_b ORDER BY s.nivel, s.nombre
  ` : `
    SELECT s.id AS seccion_id, s.nombre, s.nivel, si.idioma, sc.tec_b,
      COUNT(m.id)::int AS ocupados,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(m.subgrupo,'')) = 'A')::int AS ocupados_a,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(m.subgrupo,'')) = 'B')::int AS ocupados_b
    FROM secciones s
    JOIN secciones_anio san ON san.seccion_id=s.id AND san.anio=$1 AND san.activa=true
    LEFT JOIN secciones_idioma si ON si.seccion_id = s.id AND si.anio = $1
    LEFT JOIN secciones_config sc ON sc.seccion_id = s.id AND sc.anio = $1
    LEFT JOIN matricula m ON m.seccion_id = s.id AND m.anio = $1
    GROUP BY s.id, si.idioma, sc.tec_b ORDER BY s.nivel, s.nombre
  `;
  const r = await pool.query(q, [anio]);
  const MAX_SUB = 13;
  res.json(r.rows.map(x => ({
    ...x,
    max: MAX_CUPO,
    max_subgrupo: MAX_SUB,
    disponibles: Math.max(0, MAX_CUPO - x.ocupados),
    disponibles_a: Math.max(0, MAX_SUB - x.ocupados_a),
    disponibles_b: Math.max(0, MAX_SUB - x.ocupados_b),
  })));
});

// ── ASIGNAR SECCIÓN (año actual o futuro) ────────────────────────────────
// body: { estudiante_id, anio, seccion_id, idioma, tecnologia, forzar }
// - Año actual  → actualiza estudiantes.seccion_id directamente (comportamiento clásico)
// - Año futuro  → guarda en la tabla matricula; NO toca la sección vigente.
//   El cambio real ocurre con POST /aplicar/:anio al arrancar el año nuevo.
// - Cupo máximo 26. Solo admin puede forzar por encima del cupo (forzar=true).
router.post("/asignar", canAccess, async (req, res) => {
  const { estudiante_id, anio, seccion_id, idioma, tecnologia, forzar } = req.body;
  const a = parseInt(anio);
  if(!estudiante_id || !a || !seccion_id)
    return res.status(400).json({ error: "estudiante_id, anio y seccion_id son requeridos" });

  const u = req.session.usuario;
  const esActual = a === await anioActualCR();
  const estadoConv = await pool.query(`SELECT convocatoria,convocatoria_estado FROM matricula
    WHERE estudiante_id=$1 AND anio=$2`, [estudiante_id,a]);
  if(estadoConv.rows[0]?.convocatoria && estadoConv.rows[0]?.convocatoria_estado === 'pendiente'){
    return res.status(409).json({
      error:"Este estudiante está en espera por convocatoria. Primero registre en febrero si aprobó o reprobó; solamente después se puede asignar su sección.",
      convocatoria_pendiente:true
    });
  }

  // Esta regla nunca se puede forzar, ni siquiera por un administrador.
  // La pareja es bidireccional: da igual cuál estudiante se matriculó primero.
  const incompatibles = await conflictosEnSeccion(estudiante_id,a,seccion_id,esActual);
  if(incompatibles.length){
    const nombres = incompatibles.map(e=>
      `${e.nombre||''} ${e.primer_apellido||''} ${e.segundo_apellido||''}`.replace(/\s+/g,' ').trim()
    ).join(', ');
    return res.status(409).json({
      error:`No se puede asignar a esta sección. El estudiante tiene una restricción de convivencia con ${nombres}, que ya está en ${incompatibles[0].seccion_nombre}. Motivo: ${incompatibles[0].motivo}. Seleccione otra sección.`,
      restriccion:true,
      incompatibles
    });
  }

  // ── Verificar cupos (excluyendo al propio estudiante) ──────────────────
  // Cupo total 26 + cupo por subgrupo 13 (aplica en 10° y 11° con tecnologías)
  const MAX_SUB = 13;
  const sub = subgrupoDeTecnologia(tecnologia);
  let ocupados, ocupadosSub = 0;
  if(esActual){
    const c = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(subgrupo,'')) = $3)::int AS sub_c
      FROM estudiantes
      WHERE seccion_id=$1 AND activo=true AND (archivado=false OR archivado IS NULL) AND id<>$2
    `, [seccion_id, estudiante_id, (sub||'').toUpperCase()]);
    ocupados = c.rows[0].total;
    ocupadosSub = c.rows[0].sub_c;
  } else {
    const c = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(subgrupo,'')) = $4)::int AS sub_c
      FROM matricula WHERE seccion_id=$1 AND anio=$2 AND estudiante_id<>$3
    `, [seccion_id, a, estudiante_id, (sub||'').toUpperCase()]);
    ocupados = c.rows[0].total;
    ocupadosSub = c.rows[0].sub_c;
  }
  if(ocupados >= MAX_CUPO && !(forzar && u.rol === "admin")){
    return res.status(409).json({
      error: `La sección está llena (${ocupados}/${MAX_CUPO}). Solo el administrador puede forzar la matrícula por encima del cupo.`,
      llena: true
    });
  }
  if(sub && ocupadosSub >= MAX_SUB && !(forzar && u.rol === "admin")){
    return res.status(409).json({
      error: `El Grupo ${sub} de esta sección ya está lleno (${ocupadosSub}/${MAX_SUB}). Solo el administrador puede forzar por encima del cupo del subgrupo.`,
      subgrupo_lleno: true
    });
  }

  const secR = await pool.query("SELECT nombre FROM secciones WHERE id=$1", [seccion_id]);
  const secNombre = secR.rows[0] ? secR.rows[0].nombre : "";
  // Idioma exclusivo de la sección PARA ESE AÑO (2026: 10-3/11-3 · 2027: 10-2/11-2)
  const secIdR = await pool.query(
    "SELECT idioma FROM secciones_idioma WHERE seccion_id=$1 AND anio=$2", [seccion_id, a]);
  const secIdioma = secIdR.rows[0] ? secIdR.rows[0].idioma : null;
  // Config A/B de la sección para ese año (qué tecnología B ofrece, qué talleres)
  const secCfgR = await pool.query(
    "SELECT tec_b FROM secciones_config WHERE seccion_id=$1 AND anio=$2", [seccion_id, a]);
  const secTecB = secCfgR.rows[0] ? secCfgR.rows[0].tec_b : null;

  // Si la sección tiene configurada su tecnología B, la del estudiante debe coincidir
  // (Inglés Conversacional siempre pasa porque es A y no aplica esta validación)
  if(tecnologia && sub === 'B' && secTecB && tecnologia !== secTecB && !(forzar && u.rol === "admin")){
    return res.status(409).json({
      error: `La sección ${secNombre} ofrece "${secTecB}" como Grupo B, pero el estudiante seleccionó "${tecnologia}". Cambie la tecnología del estudiante o elija otra sección.`,
      tec_conflicto: true
    });
  }

  // ── Validación de idioma (secciones exclusivas de Francés) ────────────
  // Idioma efectivo del estudiante: el que viene en la asignación, o el
  // que ya tiene registrado (digitado por la orientadora de 9°).
  const estIdR = await pool.query("SELECT idioma FROM estudiantes WHERE id=$1", [estudiante_id]);
  const idiomaEf = idioma || (estIdR.rows[0] ? estIdR.rows[0].idioma : null);
  const secEsFrances = secIdioma === "Francés";
  const estEsFrances = idiomaEf === "Francés";
  if(secEsFrances !== estEsFrances && !(forzar && u.rol === "admin")){
    const msg = secEsFrances
      ? `La sección ${secNombre} es EXCLUSIVA de Francés y el estudiante lleva ${idiomaEf || "idioma sin registrar"}.`
      : `El estudiante lleva Francés y la sección ${secNombre} no es de Francés.`;
    return res.status(409).json({ error: msg + " Solo el administrador puede forzar esta asignación.", idioma_conflicto: true });
  }

  if(esActual){
    // Asignación inmediata + actualiza idioma/tecnología del estudiante
    await pool.query(`
      UPDATE estudiantes SET seccion_id=$1,
        idioma = COALESCE($2, idioma),
        tecnologia = COALESCE($3, tecnologia)
      WHERE id=$4
    `, [seccion_id, idioma || null, tecnologia || null, estudiante_id]);
  }
  // En ambos casos queda registrado en la tabla matricula (historial por año)
  await pool.query(`
    INSERT INTO matricula (estudiante_id, anio, seccion_id, seccion_nombre, idioma, tecnologia, subgrupo, confirmado_por, completada, estado)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,'completa')
    ON CONFLICT (estudiante_id, anio) DO UPDATE SET
      seccion_id=$3, seccion_nombre=$4,
      idioma=COALESCE($5, matricula.idioma),
      tecnologia=COALESCE($6, matricula.tecnologia),
      subgrupo=COALESCE($7, matricula.subgrupo),
      estado=CASE WHEN matricula.convocatoria=true AND matricula.convocatoria_estado IN ('aprobado','reprobado')
        THEN matricula.estado ELSE 'completa' END,
      completada=true,
      confirmado_por=$8
  `, [estudiante_id, a, seccion_id, secNombre, idioma || null, tecnologia || null, sub, u.id]);

  res.json({ ok: true, aplicado_directo: esActual, seccion_nombre: secNombre, subgrupo: sub });
});

// ── ASIGNACIONES FUTURAS DE UN AÑO (para pintar la lista) ────────────────
router.get("/asignaciones/:anio", canAccess, async (req, res) => {
  const anio = parseInt(req.params.anio);
  const r = await pool.query(`
    SELECT m.estudiante_id, m.seccion_id, m.seccion_nombre, m.idioma, m.tecnologia, m.subgrupo,
      m.convocatoria, m.convocatoria_estado, m.nivel_solicitado, m.nivel_origen
    FROM matricula m WHERE m.anio=$1
  `, [anio]);
  res.json(r.rows);
});

// Vista previa segura del cambio de año. No modifica absolutamente nada;
// permite que el administrador vea las cantidades reales antes de confirmar.
router.get("/previsualizar-aplicar/:anio", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if(u.rol !== "admin") return res.status(403).json({ error:"Solo el administrador puede revisar el cierre de año" });
  const anio = parseInt(req.params.anio);
  const anioOrigen = await obtenerAnioActivo();
  if(!anio || anio !== anioOrigen + 1)
    return res.status(409).json({ error:`El año activo es ${anioOrigen}. Solo se puede preparar el cierre hacia ${anioOrigen + 1}.` });

  const [calendario, cierre, cantidades] = await Promise.all([
    obtenerCalendario(anio),
    pool.query("SELECT aplicado_at FROM cierres_anio WHERE anio_destino=$1", [anio]),
    pool.query(`SELECT
      (SELECT COUNT(*)::int FROM estudiantes WHERE activo=true AND COALESCE(archivado,false)=false) AS estudiantes_activos,
      (SELECT COUNT(*)::int FROM matricula m JOIN estudiantes e ON e.id=m.estudiante_id
         WHERE m.anio=$1 AND m.seccion_id IS NOT NULL AND e.activo=true) AS con_matricula,
      (SELECT COUNT(*)::int FROM estudiantes e WHERE e.activo=true AND COALESCE(e.archivado,false)=false
         AND NOT EXISTS (SELECT 1 FROM matricula m WHERE m.estudiante_id=e.id AND m.anio=$1 AND m.seccion_id IS NOT NULL)) AS sin_matricula,
      (SELECT COUNT(*)::int FROM matricula m JOIN estudiantes e ON e.id=m.estudiante_id
         WHERE m.anio=$1 AND m.convocatoria=true AND m.convocatoria_estado='pendiente' AND e.activo=true) AS convocatoria_pendiente,
      (SELECT COUNT(*)::int FROM asignaciones WHERE anio=$2) AS asignaciones_origen,
      (SELECT COUNT(*)::int FROM asignaciones WHERE anio=$1) AS asignaciones_destino,
      (SELECT COUNT(*)::int FROM secciones_anio WHERE anio=$1 AND activa=true) AS secciones_destino,
      (SELECT COUNT(*)::int FROM seccion_guia_anio WHERE anio=$1 AND profesor_id IS NOT NULL) AS guias_destino,
      (SELECT COUNT(*)::int FROM seccion_orientador_anio WHERE anio=$1 AND orientador_id IS NOT NULL) AS orientadores_destino,
      (SELECT COUNT(*)::int
         FROM restricciones_matricula r
         JOIN matricula ma ON ma.estudiante_id=r.estudiante_a_id AND ma.anio=r.anio
         JOIN matricula mb ON mb.estudiante_id=r.estudiante_b_id AND mb.anio=r.anio
         WHERE r.anio=$1 AND r.activa=true AND ma.seccion_id IS NOT NULL
           AND ma.seccion_id=mb.seccion_id) AS conflictos_restricciones
    `, [anio, anioOrigen])
  ]);
  const fechasCompletas = !!(calendario.periodo_i_inicio && calendario.periodo_i_fin &&
    calendario.periodo_ii_inicio && calendario.periodo_ii_fin);
  res.json({
    anio_origen: anioOrigen,
    anio_destino: anio,
    ya_aplicado: cierre.rows.length > 0,
    calendario_completo: fechasCompletas,
    calendario,
    ...cantidades.rows[0]
  });
});

// ── APLICAR MATRÍCULAS DE UN AÑO (solo admin, un botón al arrancar) ──────
// 1. ARCHIVAR resumen académico del año anterior (nota por materia/período + faltas)
//    en la tabla `expediente_academico`. Este resumen lo consultan auxiliares/admin
//    desde el Expediente del estudiante (tab "Historial Académico").
// 2. BORRAR los datos crudos del año anterior (asistencia diaria, evaluaciones,
//    notas) para no acumular volumen en la BD.
// 3. Cada estudiante con matrícula+sección del año nuevo pasa a su sección.
// 4. Los estudiantes activos SIN matrícula quedan SIN SECCIÓN.
// 5. Se LIMPIAN los vínculos de profesor guía y orientador.
// 6. Se BORRAN las asignaciones viejas (con todos sus datos ligados por CASCADE).
router.post("/aplicar/:anio", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if(u.rol !== "admin") return res.status(403).json({ error: "Solo el administrador puede aplicar matrículas" });
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error: "Año inválido" });
  const anioAnt = await obtenerAnioActivo();
  if(anio !== anioAnt + 1)
    return res.status(409).json({ error:`El año activo es ${anioAnt}. Solo se puede aplicar ${anioAnt + 1}.` });
  const calendario = await obtenerCalendario(anio);
  const fechasOk = calendario.periodo_i_inicio && calendario.periodo_i_fin &&
    calendario.periodo_ii_inicio && calendario.periodo_ii_fin;
  if(!fechasOk)
    return res.status(409).json({ error:`Antes de aplicar ${anio}, complete las cuatro fechas lectivas en Configurar Año.` });

  // Importar calculadora de promedios del módulo calificaciones (para el resumen)
  const { calcularPromediosParaArchivo } = require("./calificaciones");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [anio]);
    const ya = await client.query("SELECT aplicado_at FROM cierres_anio WHERE anio_destino=$1", [anio]);
    if(ya.rows.length){
      await client.query("ROLLBACK");
      return res.status(409).json({ error:`Las matrículas ${anio} ya fueron aplicadas. No se ejecutó ninguna limpieza adicional.` });
    }

    // Última barrera antes de tocar datos históricos: si se creó una
    // restricción después de haber asignado las secciones, el cierre se detiene.
    const conflictosRestriccion = await client.query(`
      SELECT r.id, s.nombre AS seccion_nombre,
        TRIM(CONCAT_WS(' ', ea.nombre,ea.primer_apellido,ea.segundo_apellido)) AS estudiante_a,
        TRIM(CONCAT_WS(' ', eb.nombre,eb.primer_apellido,eb.segundo_apellido)) AS estudiante_b
      FROM restricciones_matricula r
      JOIN matricula ma ON ma.estudiante_id=r.estudiante_a_id AND ma.anio=r.anio
      JOIN matricula mb ON mb.estudiante_id=r.estudiante_b_id AND mb.anio=r.anio
      JOIN estudiantes ea ON ea.id=r.estudiante_a_id
      JOIN estudiantes eb ON eb.id=r.estudiante_b_id
      JOIN secciones s ON s.id=ma.seccion_id
      WHERE r.anio=$1 AND r.activa=true AND ma.seccion_id IS NOT NULL
        AND ma.seccion_id=mb.seccion_id
      ORDER BY s.nombre LIMIT 10
    `, [anio]);
    if(conflictosRestriccion.rows.length){
      await client.query("ROLLBACK");
      const c = conflictosRestriccion.rows[0];
      return res.status(409).json({
        error:`No se puede aplicar ${anio}: hay ${conflictosRestriccion.rows.length} restricción(es) con estudiantes en la misma sección. Revise primero ${c.estudiante_a} y ${c.estudiante_b} en ${c.seccion_nombre}.`,
        conflictos_restricciones: conflictosRestriccion.rows
      });
    }

    // ── 1. ARCHIVAR RESUMEN ACADÉMICO DEL AÑO ANTERIOR ─────────────────
    // Por cada asignación activa (del año en curso, que es el que estamos
    // cerrando), calculamos su promedio por período y guardamos el resumen
    // por cada estudiante activo de esa sección/subgrupo.
    const asigsR = await client.query(`
      SELECT a.id AS asig_id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.periodo,
        s.nombre AS seccion_nombre, m.nombre AS materia_nombre,
        u.primer_apellido AS prof_ap1, u.nombre AS prof_nombre
      FROM asignaciones a
      JOIN secciones s ON s.id = a.seccion_id
      JOIN materias m ON m.id = a.materia_id
      JOIN usuarios u ON u.id = a.profesor_id
      WHERE a.anio = $1
    `, [anioAnt]);

    let archivadas = 0, saltadas = 0;
    for(const a of asigsR.rows){
      try {
        // Calcular promedios por estudiante (usando la lógica existente)
        const data = await calcularPromediosParaArchivo(client, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.periodo);
        if(!data || !data.estudiantes){ saltadas++; continue; }
        const profNom = `${a.prof_nombre||''} ${a.prof_ap1||''}`.trim();
        for(const est of data.estudiantes){
          const rb = est.rubros || {};
          await client.query(`
            INSERT INTO expediente_academico (
              estudiante_id, anio, periodo, seccion_nombre, materia_nombre, profesor_nombre,
              nota_cotidiano, nota_tareas, nota_pruebas, nota_proyecto, nota_asistencia, nota_total,
              ausencias, ausencias_just, tardias
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            ON CONFLICT (estudiante_id, anio, periodo, materia_nombre) DO UPDATE SET
              seccion_nombre = EXCLUDED.seccion_nombre,
              profesor_nombre = EXCLUDED.profesor_nombre,
              nota_cotidiano = EXCLUDED.nota_cotidiano,
              nota_tareas = EXCLUDED.nota_tareas,
              nota_pruebas = EXCLUDED.nota_pruebas,
              nota_proyecto = EXCLUDED.nota_proyecto,
              nota_asistencia = EXCLUDED.nota_asistencia,
              nota_total = EXCLUDED.nota_total,
              ausencias = EXCLUDED.ausencias,
              ausencias_just = EXCLUDED.ausencias_just,
              tardias = EXCLUDED.tardias
          `, [
            est.estudiante_id, anioAnt, a.periodo, a.seccion_nombre, a.materia_nombre, profNom,
            rb.cotidiano ? rb.cotidiano.nota_100 : null,
            rb.tarea     ? rb.tarea.nota_100     : null,
            rb.examen    ? rb.examen.nota_100    : null,
            rb.proyecto  ? rb.proyecto.nota_100  : null,
            est.asistencia ? est.asistencia.puntos_mep : null,
            est.total || null,
            est.asistencia ? (est.asistencia.lecciones_ausentes_injust || 0) : 0,
            0, // ausencias_just: no está en el struct, quedaría en cero (se puede completar después si es útil)
            0  // tardias: idem
          ]);
          archivadas++;
        }
      } catch(e) {
        console.warn(`Archivo asig ${a.asig_id}:`, e.message);
        saltadas++;
      }
    }

    // Resumen de conducta por período/año → guardar como una "materia virtual" Conducta
    try {
      const conductaR = await client.query(`
        SELECT b.estudiante_id, b.fecha, i.puntos, e.seccion_id, s.nombre AS seccion_nombre
        FROM boletas_conducta b
        JOIN infracciones i ON i.id = b.infraccion_id
        LEFT JOIN estudiantes e ON e.id = b.estudiante_id
        LEFT JOIN secciones s ON s.id = e.seccion_id
      `);
      const rangosI  = await obtenerRangoPeriodo('I Período', client, anioAnt);
      const rangosII = await obtenerRangoPeriodo('II Período', client, anioAnt);
      const enRango = (b, rg) => String(b.fecha).slice(0,10) >= rg.desde && String(b.fecha).slice(0,10) <= rg.hasta;
      const porEst = {};
      conductaR.rows.forEach(b => {
        if(!porEst[b.estudiante_id]) porEst[b.estudiante_id] = { I: 0, II: 0, secc: b.seccion_nombre };
        if(enRango(b, rangosI))  porEst[b.estudiante_id].I  += (b.puntos||0);
        if(enRango(b, rangosII)) porEst[b.estudiante_id].II += (b.puntos||0);
      });
      for(const [eid, dat] of Object.entries(porEst)){
        for(const [per, key] of [['I Período','I'],['II Período','II']]){
          const nota = Math.max(0, 100 - dat[key]);
          await client.query(`
            INSERT INTO expediente_academico (
              estudiante_id, anio, periodo, seccion_nombre, materia_nombre,
              nota_total, conducta_nota
            ) VALUES ($1,$2,$3,$4,'Conducta',$5,$5)
            ON CONFLICT (estudiante_id, anio, periodo, materia_nombre) DO UPDATE SET
              seccion_nombre = EXCLUDED.seccion_nombre,
              nota_total = EXCLUDED.nota_total,
              conducta_nota = EXCLUDED.conducta_nota
          `, [parseInt(eid), anioAnt, per, dat.secc, nota]);
        }
      }
    } catch(e) { console.warn("Archivo conducta:", e.message); }

    // ── 2. BORRAR DATOS CRUDOS DEL AÑO ANTERIOR ───────────────────────
    // Todo ligado a asignaciones se borra en cascada al eliminar la asignación.
    // Pero antes borro explícitamente lo que no cae por cascade para tener control:
    //   - sesiones_asistencia y asistencia (cascade desde asignaciones)
    //   - evaluaciones, indicadores, notas_examen, notas_indicador (cascade)
    //   - boletas_conducta ligadas a asignaciones (cascade); las sin asignación → borrar todas
    const boletasBorradas = await client.query(
      "DELETE FROM boletas_conducta WHERE EXTRACT(YEAR FROM fecha)::int=$1 RETURNING id",
      [anioAnt]
    );

    // ── 3. Estudiantes → nueva sección + idioma/tecnología/subgrupo ───
    const apl = await client.query(`
      UPDATE estudiantes e SET
        seccion_id = m.seccion_id,
        idioma     = COALESCE(m.idioma, e.idioma),
        tecnologia = COALESCE(m.tecnologia, e.tecnologia),
        subgrupo   = COALESCE(m.subgrupo, e.subgrupo),
        nivel_matricula = s.nivel,
        matricula_completada = COALESCE(m.completada,true)
      FROM matricula m JOIN secciones s ON s.id=m.seccion_id
      WHERE m.estudiante_id = e.id AND m.anio = $1 AND m.seccion_id IS NOT NULL
        AND e.activo = true
      RETURNING e.id
    `, [anio]);

    // ── 4. Activos sin matrícula → sin sección ────────────────────────
    const sinMat = await client.query(`
      UPDATE estudiantes SET seccion_id = NULL, matricula_completada=false
      WHERE activo = true AND (archivado = false OR archivado IS NULL)
        AND id NOT IN (SELECT estudiante_id FROM matricula WHERE anio = $1 AND seccion_id IS NOT NULL)
      RETURNING id
    `, [anio]);

    // ── 5. Limpiar guía y orientador ──────────────────────────────────
    await client.query("DELETE FROM seccion_guia");
    const guiaAplicada = await client.query(`INSERT INTO seccion_guia (seccion_id,profesor_id)
      SELECT seccion_id,profesor_id FROM seccion_guia_anio
      WHERE anio=$1 AND profesor_id IS NOT NULL RETURNING seccion_id`, [anio]);
    await client.query("DELETE FROM seccion_orientador");
    const oriAplicada = await client.query(`INSERT INTO seccion_orientador (seccion_id,orientador_id)
      SELECT seccion_id,orientador_id FROM seccion_orientador_anio
      WHERE anio=$1 AND orientador_id IS NOT NULL RETURNING seccion_id`, [anio]);

    // ── 5.b. Borrar horarios del año anterior (los del año nuevo, si el
    //         admin ya los creó por adelantado, quedan intactos) ─────────
    const horBorrados = await client.query(
      "DELETE FROM horarios WHERE anio = $1 OR anio IS NULL RETURNING id",
      [anioAnt]
    );

    // ── 6. BORRAR asignaciones del año anterior (cascade borra sesiones,
    //         notas, evaluaciones ligadas). Las del año NUEVO que el admin
    //         haya preparado quedan intactas para que los profes arranquen
    //         febrero con todo listo. ─────────────────────────────────────
    const asigBorradas = await client.query(
      "DELETE FROM asignaciones WHERE COALESCE(anio, $1) = $1 RETURNING id",
      [anioAnt]
    );

    // Contar cuántas asignaciones del año nuevo ya estaban preparadas
    const asigNuevas = await client.query(
      "SELECT COUNT(*)::int AS c FROM asignaciones WHERE anio = $1", [anio]
    );

    await client.query("UPDATE anios_lectivos SET estado='cerrado',updated_at=NOW() WHERE anio=$1", [anioAnt]);
    await client.query(`UPDATE anios_lectivos SET estado='activo',aplicado_at=NOW(),aplicado_por=$2,updated_at=NOW()
      WHERE anio=$1`, [anio,u.id]);
    const resumenCierre = {
      aplicados: apl.rows.length, sin_seccion: sinMat.rows.length,
      asignaciones_borradas: asigBorradas.rows.length,
      boletas_borradas: boletasBorradas.rows.length,
      resumenes_archivados: archivadas, resumenes_saltados: saltadas
    };
    await client.query(`INSERT INTO cierres_anio (anio_destino,anio_origen,aplicado_por,resumen)
      VALUES ($1,$2,$3,$4::jsonb)`, [anio,anioAnt,u.id,JSON.stringify(resumenCierre)]);

    await client.query("COMMIT");
    res.json({
      ok: true,
      aplicados: apl.rows.length,
      sin_seccion: sinMat.rows.length,
      guias_limpiadas: 0,
      orientadores_limpiados: 0,
      guias_aplicadas: guiaAplicada.rows.length,
      orientadores_aplicados: oriAplicada.rows.length,
      asignaciones_borradas: asigBorradas.rows.length,
      asignaciones_nuevas_preparadas: asigNuevas.rows[0].c,
      boletas_borradas: boletasBorradas.rows.length,
      horarios_borrados: horBorrados.rows.length,
      resumenes_archivados: archivadas,
      resumenes_saltados: saltadas,
      anio,
      anio_archivado: anioAnt
    });
  } catch(e) {
    await client.query("ROLLBACK");
    console.error("Aplicar matrículas:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── RESOLUCIÓN DE CONVOCATORIA ────────────────────────────────────────────
// Resolver en febrero únicamente las matrículas que quedaron pendientes por
// convocatoria. Aprobado: conserva el nivel solicitado. Reprobado: vuelve al
// nivel que cursaba, pero se elige una sección disponible de ese nivel.
router.post("/convocatoria/:id/resolver", canAccess, async (req, res) => {
  const estudianteId = parseInt(req.params.id);
  const anio = parseInt(req.body?.anio);
  const resultado = String(req.body?.resultado || "").toLowerCase();
  const seccionId = parseInt(req.body?.seccion_id);
  const forzar = req.body?.forzar === true && req.session.usuario.rol === "admin";
  if(!estudianteId || !anio || !seccionId || !["aprobado","reprobado"].includes(resultado))
    return res.status(400).json({ error:"Indique año, resultado y sección." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mr = await client.query(`SELECT m.*,e.idioma AS est_idioma,e.tecnologia AS est_tecnologia,
        e.subgrupo AS est_subgrupo
      FROM matricula m JOIN estudiantes e ON e.id=m.estudiante_id
      WHERE m.estudiante_id=$1 AND m.anio=$2 FOR UPDATE`, [estudianteId,anio]);
    if(!mr.rows.length){ await client.query("ROLLBACK"); return res.status(404).json({ error:"Matrícula no encontrada." }); }
    const m = mr.rows[0];
    if(!m.convocatoria || m.convocatoria_estado !== "pendiente"){
      await client.query("ROLLBACK");
      return res.status(409).json({ error:"Solo se pueden resolver estudiantes que estén en convocatoria pendiente." });
    }
    const nivelDestino = resultado === "aprobado" ? parseInt(m.nivel_solicitado) : parseInt(m.nivel_origen);
    if(!nivelDestino){ await client.query("ROLLBACK"); return res.status(409).json({ error:"La matrícula no conserva el nivel necesario para resolver la convocatoria." }); }
    const sr = await client.query(`SELECT s.id,s.nombre,s.nivel FROM secciones s
      JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=$2 AND sa.activa=true
      WHERE s.id=$1`, [seccionId,anio]);
    if(!sr.rows.length || parseInt(sr.rows[0].nivel) !== nivelDestino){
      await client.query("ROLLBACK");
      return res.status(409).json({ error:`Seleccione una sección activa de nivel ${nivelDestino} para el ${anio}.` });
    }
    const esActual = anio === await anioActualCR();
    const incompatibles = await conflictosEnSeccion(estudianteId,anio,seccionId,esActual,client);
    if(incompatibles.length){
      await client.query("ROLLBACK");
      const nombres=incompatibles.map(x=>`${x.nombre||''} ${x.primer_apellido||''} ${x.segundo_apellido||''}`.replace(/\s+/g,' ').trim()).join(', ');
      return res.status(409).json({ error:`No se puede usar esa sección: existe una restricción de convivencia con ${nombres}. Seleccione otra sección.`, restriccion:true });
    }
    const idiomaEf = m.idioma || m.est_idioma || null;
    const tecnologiaEf = m.tecnologia || m.est_tecnologia || null;
    const subgrupoEf = m.subgrupo || subgrupoDeTecnologia(tecnologiaEf) || m.est_subgrupo || null;
    const cupo = esActual
      ? await client.query(`SELECT COUNT(*)::int AS c,
          COUNT(*) FILTER (WHERE UPPER(COALESCE(subgrupo,''))=$3)::int AS sub_c
          FROM estudiantes WHERE seccion_id=$1 AND activo=true
          AND COALESCE(archivado,false)=false AND id<>$2`,
          [seccionId,estudianteId,String(subgrupoEf||'').toUpperCase()])
      : await client.query(`SELECT COUNT(*)::int AS c,
          COUNT(*) FILTER (WHERE UPPER(COALESCE(subgrupo,''))=$4)::int AS sub_c
          FROM matricula WHERE seccion_id=$1 AND anio=$2 AND estudiante_id<>$3`,
          [seccionId,anio,estudianteId,String(subgrupoEf||'').toUpperCase()]);
    if(cupo.rows[0].c >= MAX_CUPO && !forzar){
      await client.query("ROLLBACK");
      return res.status(409).json({ error:`La sección está llena (${cupo.rows[0].c}/${MAX_CUPO}). Seleccione otra sección.`, llena:true });
    }
    if(subgrupoEf && cupo.rows[0].sub_c >= 13 && !forzar){
      await client.query("ROLLBACK");
      return res.status(409).json({ error:`El Grupo ${subgrupoEf} de esa sección está lleno (${cupo.rows[0].sub_c}/13). Seleccione otra sección.`, subgrupo_lleno:true });
    }
    const [idiomaSec,cfgSec] = await Promise.all([
      client.query("SELECT idioma FROM secciones_idioma WHERE seccion_id=$1 AND anio=$2",[seccionId,anio]),
      client.query("SELECT tec_b FROM secciones_config WHERE seccion_id=$1 AND anio=$2",[seccionId,anio])
    ]);
    const secEsFrances = idiomaSec.rows[0]?.idioma === "Francés";
    const estEsFrances = idiomaEf === "Francés";
    if(secEsFrances !== estEsFrances && !forzar){
      await client.query("ROLLBACK");
      const detalle=secEsFrances
        ? `La sección ${sr.rows[0].nombre} es exclusiva de Francés y el estudiante lleva ${idiomaEf||'idioma sin registrar'}.`
        : `El estudiante lleva Francés y la sección ${sr.rows[0].nombre} no es de Francés.`;
      return res.status(409).json({ error:detalle+" Seleccione otra sección.",idioma_conflicto:true });
    }
    const tecB=cfgSec.rows[0]?.tec_b||null;
    if(subgrupoEf === 'B' && tecB && tecnologiaEf && tecnologiaEf !== tecB && !forzar){
      await client.query("ROLLBACK");
      return res.status(409).json({ error:`La sección ${sr.rows[0].nombre} ofrece “${tecB}” para el Grupo B, pero el estudiante tiene “${tecnologiaEf}”. Seleccione otra sección.`,tec_conflicto:true });
    }
    const estado = resultado === "aprobado" ? "convocatoria_aprobada" : "convocatoria_reprobada";
    await client.query(`UPDATE matricula SET seccion_id=$1,seccion_nombre=$2,
      estado=$3,completada=true,convocatoria_estado=$4,
      idioma=COALESCE($5,idioma),tecnologia=COALESCE($6,tecnologia),subgrupo=COALESCE($7,subgrupo),
      convocatoria_resuelta_por=$8,convocatoria_resuelta_at=NOW()
      WHERE estudiante_id=$9 AND anio=$10`,
      [seccionId,sr.rows[0].nombre,estado,resultado,idiomaEf,tecnologiaEf,subgrupoEf,
       req.session.usuario.id,estudianteId,anio]);
    if(esActual){
      await client.query(`UPDATE estudiantes SET seccion_id=$1,nivel_matricula=$2,
        idioma=COALESCE($3,idioma),tecnologia=COALESCE($4,tecnologia),
        subgrupo=COALESCE($5,subgrupo),matricula_completada=true WHERE id=$6`,
        [seccionId,nivelDestino,idiomaEf,tecnologiaEf,subgrupoEf,estudianteId]);
    }
    await client.query(`INSERT INTO historial_estudiante
      (estudiante_id,tipo,valor_anterior,valor_nuevo,justificacion,usuario_id)
      VALUES ($1,'resolucion_convocatoria','Convocatoria pendiente',$2,$3,$4)`,
      [estudianteId,`${resultado} - ${sr.rows[0].nombre}`,
       resultado === "aprobado" ? `Avanza al nivel ${nivelDestino}` : `Permanece en el nivel ${nivelDestino}`,
       req.session.usuario.id]);
    await client.query("COMMIT");
    res.json({ ok:true,resultado,nivel:nivelDestino,seccion_id:seccionId,seccion_nombre:sr.rows[0].nombre });
  } catch(e) {
    try{ await client.query("ROLLBACK"); }catch{}
    console.error("Resolver convocatoria:",e);
    res.status(500).json({ error:e.message });
  } finally { client.release(); }
});

// Datos oficiales para la carta de bienvenida y el horario individual. La
// sección sale de la matrícula anual, no de la sección del año anterior.
router.get("/carta-horario/:id/:anio", canAccess, async (req, res) => {
  const estudianteId=parseInt(req.params.id), anio=parseInt(req.params.anio);
  if(!estudianteId||!anio) return res.status(400).json({ error:"Datos inválidos." });
  const er=await pool.query(`SELECT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,
      m.seccion_id,m.seccion_nombre,m.subgrupo,m.convocatoria,m.convocatoria_estado,s.nivel
    FROM estudiantes e JOIN matricula m ON m.estudiante_id=e.id AND m.anio=$2
    JOIN secciones s ON s.id=m.seccion_id WHERE e.id=$1 AND m.seccion_id IS NOT NULL`, [estudianteId,anio]);
  if(!er.rows.length) return res.status(409).json({ error:"Primero debe asignar una sección para poder generar la carta y el horario." });
  if(er.rows[0].convocatoria && er.rows[0].convocatoria_estado === "pendiente")
    return res.status(409).json({ error:"La carta se genera después de resolver la convocatoria y asignar la sección." });
  const [cr,gr] = await Promise.all([
    pool.query(`SELECT h.dia,h.leccion,h.aula,h.materia_texto,a.subgrupo,
        m.nombre AS materia_nombre
      FROM horarios h LEFT JOIN asignaciones a ON a.id=h.asignacion_id
      LEFT JOIN materias m ON m.id=a.materia_id
      WHERE h.seccion_id=$1 AND h.anio=$2 ORDER BY h.dia,h.leccion,h.id`, [er.rows[0].seccion_id,anio]),
    pool.query(`SELECT u.nombre,u.primer_apellido,u.segundo_apellido
      FROM seccion_guia_anio sg JOIN usuarios u ON u.id=sg.profesor_id
      WHERE sg.seccion_id=$1 AND sg.anio=$2 LIMIT 1`, [er.rows[0].seccion_id,anio])
  ]);
  let director="Licda. Laura Cruz Jiménez";
  try{
    const cfg=await pool.query("SELECT director_nombre FROM config_centro ORDER BY id LIMIT 1");
    if(cfg.rows[0]?.director_nombre) director=cfg.rows[0].director_nombre;
  }catch{}
  res.json({ estudiante:er.rows[0],anio,guia:gr.rows[0]||null,director,
    lecciones:obtenerLecciones(anio),celdas:cr.rows });
});

// ── SECCIONES DE FRANCÉS POR AÑO ─────────────────────────────────────────
// GET: marcas del año. PUT (solo admin): marcar/desmarcar una sección.
router.get("/secciones-idioma/:anio", canAccess, async (req, res) => {
  const r = await pool.query(
    "SELECT seccion_id, idioma FROM secciones_idioma WHERE anio=$1", [parseInt(req.params.anio)]);
  res.json(r.rows);
});

router.put("/secciones-idioma", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if(u.rol !== "admin") return res.status(403).json({ error: "Solo el administrador puede marcar secciones de idioma" });
  const { seccion_id, anio, idioma } = req.body;
  const a = parseInt(anio);
  if(!seccion_id || !a) return res.status(400).json({ error: "seccion_id y anio requeridos" });
  if(idioma && idioma !== "Francés")
    return res.status(400).json({ error: "Idioma inválido (solo 'Francés' o vacío)" });
  if(idioma){
    await pool.query(`
      INSERT INTO secciones_idioma (seccion_id, anio, idioma) VALUES ($1,$2,$3)
      ON CONFLICT (seccion_id, anio) DO UPDATE SET idioma=$3
    `, [seccion_id, a, idioma]);
  } else {
    await pool.query("DELETE FROM secciones_idioma WHERE seccion_id=$1 AND anio=$2", [seccion_id, a]);
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  IDIOMA Y TECNOLOGÍA — módulo de la orientadora de 9° (9° → 10°)
// ═══════════════════════════════════════════════════════════════════════════

// Middleware de LECTURA: admin, auxiliar, administrativo, orientador (todos ven)
async function canIdiomaTec(req, res, next){
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error: "No autorizado" });
  const fx = u.funciones_extra || [];
  if(["admin","auxiliar","administrativo"].includes(u.rol)) return next();
  if(u.rol === "orientador" || fx.includes("orientador")) return next();
  return res.status(403).json({ error: "Sin permisos" });
}

// Middleware de ESCRITURA: solo admin, administrativo y orientador
// (auxiliares SOLO ven, no editan idioma/tecnología/boleta desde este módulo)
async function canEditarIdiomaTec(req, res, next){
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error: "No autorizado" });
  const fx = u.funciones_extra || [];
  if(["admin","administrativo"].includes(u.rol)) return next();
  if(u.rol === "orientador" || fx.includes("orientador")) return next();
  return res.status(403).json({ error: "Los auxiliares tienen acceso de solo lectura en este módulo. Para modificar idioma/tecnología, hacelo desde el módulo de Matrícula al asignar la sección." });
}

// Lista estudiantes de NOVENO. Orientador → solo sus secciones asignadas.
// Auxiliares y administrativos → todas las secciones (solo lectura).
router.get("/idioma-tecnologia", canIdiomaTec, async (req, res) => {
  const u = req.session.usuario;
  const fx = u.funciones_extra || [];
  const esOrientador = (u.rol === "orientador" || fx.includes("orientador")) &&
                       !["admin","auxiliar","administrativo"].includes(u.rol);
  const puedeEditar = ["admin","administrativo"].includes(u.rol) ||
                      u.rol === "orientador" || fx.includes("orientador");
  let filtro = "", params = [];
  if(esOrientador){
    const secs = await pool.query("SELECT seccion_id FROM seccion_orientador WHERE orientador_id=$1", [u.id]);
    if(!secs.rows.length) return res.json({ puede_editar: puedeEditar, estudiantes: [] });
    params.push(secs.rows.map(r=>r.seccion_id));
    filtro = `AND e.seccion_id = ANY($${params.length}::int[])`;
  }
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.idioma, e.tecnologia, e.boleta_entregada, s.nombre AS seccion_nombre
    FROM estudiantes e
    JOIN secciones s ON s.id = e.seccion_id
    WHERE e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
      AND s.nivel = 9 ${filtro}
    ORDER BY s.nombre, e.primer_apellido, e.segundo_apellido, e.nombre
  `, params);
  res.json({ puede_editar: puedeEditar, estudiantes: r.rows });
});

// Guardar idioma/tecnología de un estudiante (autosave por fila) — solo editores
router.put("/idioma-tecnologia/:id", canEditarIdiomaTec, async (req, res) => {
  const { idioma, tecnologia } = req.body;
  await pool.query(`
    UPDATE estudiantes SET idioma=$1, tecnologia=$2 WHERE id=$3
  `, [idioma || null, tecnologia || null, req.params.id]);
  res.json({ ok: true });
});

// Marcar/desmarcar boleta entregada (autosave) — admin/administrativo/auxiliar/orientador
// (auxiliar sí puede marcar cuando recibe la boleta al momento de matricular)
router.put("/boleta-entregada/:id", canIdiomaTec, async (req, res) => {
  const { entregada } = req.body;
  await pool.query("UPDATE estudiantes SET boleta_entregada=$1 WHERE id=$2",
    [entregada ? true : false, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;

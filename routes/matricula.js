const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

function canAccess(req, res, next) {
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error:"No autorizado" });
  if(["admin","auxiliar","administrativo"].includes(u.rol)) return next();
  pool.query("SELECT 1 FROM matricula_comite WHERE usuario_id=$1", [u.id])
    .then(r => r.rows.length ? next() : res.status(403).json({ error:"Sin permisos" }))
    .catch(() => res.status(403).json({ error:"Sin permisos" }));
}

// ── LISTAR MATRÍCULAS ─────────────────────────────────────────────────
router.get("/", canAccess, async (req, res) => {
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.tipo_ingreso, e.nivel_matricula, e.matricula_completada,
      e.seccion_id, s.nombre AS seccion_nombre,
      e.created_at
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.activo=true AND (e.archivado=false OR e.archivado IS NULL)
    ORDER BY e.primer_apellido, e.nombre
  `);
  res.json(r.rows);
});

// ── CARGAR POR CÉDULA ─────────────────────────────────────────────────
router.get("/cedula/:cedula", canAccess, async (req, res) => {
  const r = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.cedula=$1 AND e.activo=true
  `, [req.params.cedula]);
  if(!r.rows.length){
    // Intentar en prematrícula
    const p = await pool.query(`
      SELECT p.*, pe.parentesco, pe.cedula AS enc_cedula, pe.nombre AS enc_nombre,
        pe.primer_apellido AS enc_ap1, pe.segundo_apellido AS enc_ap2,
        pe.nacionalidad AS enc_nacionalidad, pe.fecha_nacimiento AS enc_fecha_nac
      FROM prematricula p
      LEFT JOIN prematricula_encargado pe ON pe.prematricula_id=p.id
      WHERE p.cedula=$1
    `, [req.params.cedula]);
    if(p.rows.length) return res.json({ fuente:"prematricula", ...p.rows[0] });
    return res.json(null);
  }
  const encs = await pool.query("SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC", [r.rows[0].id]);
  res.json({ fuente:"estudiante", ...r.rows[0], encargados: encs.rows });
});

// ── GUARDAR PASO 2 (datos completos) ─────────────────────────────────
router.post("/guardar", canAccess, async (req, res) => {
  const {
    cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento,
    sexo, nacionalidad, correo, institucion_procedencia,
    provincia, canton, distrito, direccion_exacta,
    habita_con, habita_con_otro, adecuacion, tipo_ingreso, nivel_matricula,
    enfermedad, medicamento, telefonos_emergencia,
    encargados
  } = req.body;

  if(!cedula||!nombre||!primer_apellido) return res.status(400).json({ error:"Datos incompletos." });
  const uid = req.session.usuario.id;

  // Verificar si ya existe
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
    for(let i=0;i<encargados.length;i++){
      const e = encargados[i];
      await pool.query(`
        INSERT INTO encargados
          (estudiante_id, parentesco, cedula, nombre, primer_apellido, segundo_apellido,
           nacionalidad, profesion, lugar_trabajo, telefono, celular, telefono_trabajo,
           email, es_principal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [estId, e.parentesco||null, e.cedula||null, e.nombre||null, e.primer_apellido||null,
          e.segundo_apellido||null, e.nacionalidad||null, e.profesion||null, e.lugar_trabajo||null,
          e.telefono||null, e.celular||null, e.telefono_trabajo||null, e.email||null, i===0]);
    }
  }

  // Si venía de prematrícula, marcar como matriculado
  await pool.query("UPDATE prematricula SET estado='matriculado' WHERE cedula=$1", [cedula]);

  res.json({ ok:true, estudiante_id: estId });
});

// ── GUARDAR BECA COMEDOR ──────────────────────────────────────────────
router.post("/beca-comedor", canAccess, async (req, res) => {
  const {
    estudiante_id, cedula_estudiante, personas_hogar, tipo_vivienda, vive_con,
    ingreso_mensual, recibe_avancemos, monto_avancemos, otros_ingresos, motivos
  } = req.body;

  const ingreso = parseFloat(ingreso_mensual)||0;
  const personas = parseInt(personas_hogar)||1;
  const percapita = personas > 0 ? ingreso/personas : ingreso;

  let clasificacion, resolucion;
  if(percapita < 100000){
    clasificacion="Alta vulnerabilidad"; resolucion="aprobado";
  } else if(percapita <= 180000){
    clasificacion="Vulnerabilidad media"; resolucion="aprobado";
  } else if(percapita <= 300000){
    clasificacion="Vulnerabilidad baja"; resolucion="pendiente";
  } else {
    clasificacion="Fuera de prioridad"; resolucion="pendiente";
  }

  // Guardar solicitud
  await pool.query(`
    INSERT INTO solicitud_beca_comedor
      (estudiante_id, cedula_estudiante, personas_hogar, tipo_vivienda, vive_con,
       ingreso_mensual, recibe_avancemos, monto_avancemos, otros_ingresos, motivos,
       ingreso_percapita, clasificacion, resolucion, registrado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT DO NOTHING
  `, [estudiante_id||null, cedula_estudiante||null, personas, tipo_vivienda||null, vive_con||null,
      ingreso, recibe_avancemos||false, monto_avancemos||0, otros_ingresos||null, motivos||null,
      percapita, clasificacion, resolucion, req.session.usuario.id]);

  // Auto-aprobar beca si aplica
  if(resolucion==="aprobado" && estudiante_id){
    await pool.query("UPDATE estudiantes SET becado=true WHERE id=$1", [estudiante_id]);
  }

  res.json({ ok:true, percapita, clasificacion, resolucion });
});

// ── GUARDAR ADECUACIÓN ────────────────────────────────────────────────
router.post("/adecuacion", canAccess, async (req, res) => {
  const { estudiante_id, motivo, antecedentes } = req.body;
  await pool.query(`
    INSERT INTO solicitud_adecuacion (estudiante_id, motivo, antecedentes, registrado_por)
    VALUES ($1,$2,$3,$4)
  `, [estudiante_id||null, motivo||null, antecedentes||null, req.session.usuario.id]);

  // Actualizar campo adecuacion en estudiantes
  if(estudiante_id){
    await pool.query("UPDATE estudiantes SET adecuacion='significativa' WHERE id=$1", [estudiante_id]);
  }
  res.json({ ok:true });
});

// ── COMPLETAR MATRÍCULA ───────────────────────────────────────────────
router.post("/completar/:id", canAccess, async (req, res) => {
  await pool.query("UPDATE estudiantes SET matricula_completada=true WHERE id=$1", [req.params.id]);
  res.json({ ok:true });
});

// ── ELIMINAR MATRÍCULA ────────────────────────────────────────────────
router.delete("/:id", canAccess, async (req, res) => {
  const { justificacion } = req.body || {};
  if(!justificacion?.trim())
    return res.status(400).json({ error:"La justificación es obligatoria." });

  const r = await pool.query("SELECT id, cedula, nombre FROM estudiantes WHERE id=$1", [req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error:"Estudiante no encontrado." });

  // Marcar como inactivo (no borrar — conservar historial)
  await pool.query(
    "UPDATE estudiantes SET activo=false, matricula_completada=false WHERE id=$1",
    [req.params.id]
  );
  res.json({ ok:true });
});

module.exports = router;

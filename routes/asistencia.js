const router = require("express").Router();
const { pool } = require("../db");
const { requireDocente } = require("../middleware/auth");

// ── MIS ASIGNACIONES ──────────────────────────────────────────────────────────
router.get("/mis-asignaciones", requireDocente, async (req, res) => {
  const uid = req.session.usuario.id;
  const r = await pool.query(`
    SELECT a.id, a.lecciones_semana,
      s.nombre AS seccion_nombre, s.nivel,
      m.nombre AS materia_nombre,
      (SELECT COUNT(*) FROM sesiones_asistencia sa WHERE sa.asignacion_id=a.id) AS sesiones_total
    FROM asignaciones a
    JOIN secciones s ON s.id=a.seccion_id
    JOIN materias m ON m.id=a.materia_id
    WHERE a.profesor_id=$1
    ORDER BY s.nombre, m.nombre
  `, [uid]);
  res.json(r.rows);
});

// ── OBTENER ASISTENCIA DE UNA SESIÓN ─────────────────────────────────────────
// GET /asistencia/:asignacion_id/:fecha
router.get("/:asignacion_id/:fecha", requireDocente, async (req, res) => {
  const { asignacion_id, fecha } = req.params;

  // Buscar sesión existente
  const sesR = await pool.query(
    "SELECT * FROM sesiones_asistencia WHERE asignacion_id=$1 AND fecha=$2",
    [asignacion_id, fecha]
  );

  // Estudiantes de la sección
  const asigR = await pool.query(
    "SELECT seccion_id FROM asignaciones WHERE id=$1", [asignacion_id]
  );
  if (!asigR.rows.length) return res.status(404).json({ error:"Asignación no encontrada" });

  const estR = await pool.query(`
    SELECT id, cedula, nombre, primer_apellido, segundo_apellido
    FROM estudiantes WHERE seccion_id=$1 AND activo=true
    ORDER BY primer_apellido, segundo_apellido, nombre
  `, [asigR.rows[0].seccion_id]);

  if (!sesR.rows.length) {
    // Sesión vacía, todos presentes por defecto
    return res.json({
      sesion: null,
      estudiantes: estR.rows.map(e => ({ ...e, estado:"P", justificada:false, motivo:"" }))
    });
  }

  const sesion = sesR.rows[0];
  const asistR = await pool.query(
    "SELECT * FROM asistencia WHERE sesion_id=$1", [sesion.id]
  );
  const asistMap = {};
  asistR.rows.forEach(a => asistMap[a.estudiante_id] = a);

  const estudiantes = estR.rows.map(e => ({
    ...e,
    estado: asistMap[e.id]?.estado || "P",
    justificada: asistMap[e.id]?.justificada || false,
    motivo: asistMap[e.id]?.motivo || "",
    asistencia_id: asistMap[e.id]?.id || null
  }));

  res.json({ sesion, estudiantes });
});

// ── GUARDAR ASISTENCIA ────────────────────────────────────────────────────────
// POST /asistencia  { asignacion_id, fecha, lecciones, registros:[{estudiante_id, estado}] }
router.post("/", requireDocente, async (req, res) => {
  const { asignacion_id, fecha, lecciones, registros } = req.body;
  if (!asignacion_id||!fecha||!lecciones||!registros)
    return res.status(400).json({ error:"Datos incompletos" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Crear o actualizar sesión
    const sesR = await client.query(`
      INSERT INTO sesiones_asistencia (asignacion_id, fecha, lecciones)
      VALUES ($1,$2,$3)
      ON CONFLICT (asignacion_id, fecha) DO UPDATE SET lecciones=$3
      RETURNING id
    `, [asignacion_id, fecha, lecciones]);
    const sesion_id = sesR.rows[0].id;

    // Insertar/actualizar cada registro
    for (const r of registros) {
      await client.query(`
        INSERT INTO asistencia (sesion_id, estudiante_id, estado, justificada, motivo)
        VALUES ($1,$2,$3,false,'')
        ON CONFLICT (sesion_id, estudiante_id) DO UPDATE SET estado=$3
      `, [sesion_id, r.estudiante_id, r.estado]);
    }

    await client.query("COMMIT");
    res.json({ ok:true, sesion_id });
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error:e.message });
  } finally {
    client.release();
  }
});

// ── JUSTIFICAR AUSENCIA ───────────────────────────────────────────────────────
router.put("/justificar/:asistencia_id", requireDocente, async (req, res) => {
  const { justificada, motivo } = req.body;
  await pool.query(
    "UPDATE asistencia SET justificada=$1, motivo=$2 WHERE id=$3",
    [justificada, motivo||"", req.params.asistencia_id]
  );
  res.json({ ok:true });
});

// ── ELIMINAR SESIÓN (borra todos los registros del día) ───────────────────────
router.delete("/sesion/:sesion_id", requireDocente, async (req, res) => {
  await pool.query("DELETE FROM sesiones_asistencia WHERE id=$1", [req.params.sesion_id]);
  res.json({ ok:true });
});

// ── HISTORIAL DE SESIONES DE UNA ASIGNACIÓN ───────────────────────────────────
router.get("/historial/:asignacion_id", requireDocente, async (req, res) => {
  const r = await pool.query(`
    SELECT sa.*, 
      COUNT(a.id) FILTER (WHERE a.estado='A') AS total_ausentes,
      COUNT(a.id) FILTER (WHERE a.estado='T') AS total_tardias,
      COUNT(a.id) FILTER (WHERE a.estado='P') AS total_presentes
    FROM sesiones_asistencia sa
    LEFT JOIN asistencia a ON a.sesion_id=sa.id
    WHERE sa.asignacion_id=$1
    GROUP BY sa.id
    ORDER BY sa.fecha DESC
  `, [req.params.asignacion_id]);
  res.json(r.rows);
});

module.exports = router;

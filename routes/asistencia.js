const router = require("express").Router();
const { pool } = require("../db");
const { requireDocente } = require("../middleware/auth");

// ── MIS ASIGNACIONES ──────────────────────────────────────────────────────────
router.get("/mis-asignaciones", requireDocente, async (req, res) => {
  const uid = req.session.usuario.id;
  const r = await pool.query(`
    SELECT a.id, a.lecciones_semana, a.subgrupo,
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

// ── HISTORIAL DE SESIONES DE UNA ASIGNACIÓN ───────────────────────────────────
// ⚠️ Esta ruta debe ir ANTES de /:asignacion_id/:fecha para evitar conflicto
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

// ── OBTENER ASISTENCIA DE UNA SESIÓN ─────────────────────────────────────────
router.get("/:asignacion_id/:fecha", requireDocente, async (req, res) => {
  const { asignacion_id, fecha } = req.params;

  const sesR = await pool.query(
    "SELECT * FROM sesiones_asistencia WHERE asignacion_id=$1 AND fecha=$2",
    [asignacion_id, fecha]
  );

  // Obtener sección y subgrupo de la asignación
  const asigR = await pool.query(
    "SELECT seccion_id, subgrupo FROM asignaciones WHERE id=$1", [asignacion_id]
  );
  if (!asigR.rows.length) return res.status(404).json({ error:"Asignación no encontrada" });

  const { seccion_id, subgrupo } = asigR.rows[0];

  // Filtrar estudiantes por subgrupo si aplica
  let estQuery = `SELECT id, cedula, nombre, primer_apellido, segundo_apellido
    FROM estudiantes WHERE seccion_id=$1 AND activo=true`;
  const estParams = [seccion_id];
  if (subgrupo) {
    estParams.push(subgrupo);
    estQuery += ` AND subgrupo=$${estParams.length}`;
  }
  estQuery += ` ORDER BY primer_apellido, segundo_apellido, nombre`;
  const estR = await pool.query(estQuery, estParams);

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
    lecciones_ausentes: asistMap[e.id]?.lecciones_ausentes || null,
    justificada: asistMap[e.id]?.justificada || false,
    motivo: asistMap[e.id]?.motivo || "",
    asistencia_id: asistMap[e.id]?.id || null
  }));

  res.json({ sesion, estudiantes });
});

// ── GUARDAR ASISTENCIA ────────────────────────────────────────────────────────
router.post("/", requireDocente, async (req, res) => {
  const { asignacion_id, fecha, lecciones, registros } = req.body;
  if (!asignacion_id||!fecha||!lecciones||!registros)
    return res.status(400).json({ error:"Datos incompletos" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sesR = await client.query(`
      INSERT INTO sesiones_asistencia (asignacion_id, fecha, lecciones)
      VALUES ($1,$2,$3)
      ON CONFLICT (asignacion_id, fecha) DO UPDATE SET lecciones=$3
      RETURNING id
    `, [asignacion_id, fecha, lecciones]);
    const sesion_id = sesR.rows[0].id;

    for (const r of registros) {
      // lecciones_ausentes: si es Ausente y no se especifica, usar total de lecciones
      const lecAus = r.estado === 'A' ? (r.lecciones_ausentes || lecciones) : null;
      await client.query(`
        INSERT INTO asistencia (sesion_id, estudiante_id, estado, lecciones_ausentes, justificada, motivo)
        VALUES ($1,$2,$3,$4,false,'')
        ON CONFLICT (sesion_id, estudiante_id) DO UPDATE SET estado=$3, lecciones_ausentes=$4
      `, [sesion_id, r.estudiante_id, r.estado, lecAus]);
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

module.exports = router;

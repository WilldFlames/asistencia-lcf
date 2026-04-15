const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");

const canManage = requireRol("admin","auxiliar","orientador","profesor_guia");

// ── INFRACCIONES (catálogo) ───────────────────────────────────────────────────
router.get("/infracciones", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM infracciones ORDER BY tipo, puntos, id");
  res.json(r.rows);
});

// ── BOLETAS DE UN ESTUDIANTE ──────────────────────────────────────────────────
router.get("/estudiante/:id", requireAuth, async (req, res) => {
  const { desde, hasta } = req.query;
  let sql = `
    SELECT b.*,
      i.tipo AS infraccion_tipo,
      i.puntos,
      i.descripcion AS infraccion_desc,
      m.nombre AS materia_nombre,
      u.nombre AS prof_nombre,
      u.primer_apellido AS prof_ap1,
      r.nombre AS reg_nombre,
      r.primer_apellido AS reg_ap1,
      r.rol AS reg_rol
    FROM boletas_conducta b
    JOIN infracciones i ON i.id = b.infraccion_id
    LEFT JOIN asignaciones a ON a.id = b.asignacion_id
    LEFT JOIN materias m ON m.id = a.materia_id
    LEFT JOIN usuarios u ON u.id = a.profesor_id
    JOIN usuarios r ON r.id = b.registrado_por
    WHERE b.estudiante_id = $1
  `;
  const params = [req.params.id];
  if (desde) { params.push(desde); sql += ` AND b.fecha >= $${params.length}`; }
  if (hasta) { params.push(hasta); sql += ` AND b.fecha <= $${params.length}`; }
  sql += " ORDER BY b.fecha DESC, b.created_at DESC";

  const r = await pool.query(sql, params);
  const totalRebajado = r.rows.reduce((s, b) => s + b.puntos, 0);
  const notaConduccion = Math.max(0, 100 - totalRebajado);

  res.json({ boletas: r.rows, totalRebajado, notaConducta: notaConduccion });
});

// ── REGISTRAR BOLETA ──────────────────────────────────────────────────────────
router.post("/", canManage, async (req, res) => {
  const { estudiante_id, infraccion_id, asignacion_id, fecha, observacion } = req.body;
  if (!estudiante_id || !infraccion_id || !fecha)
    return res.status(400).json({ error: "Estudiante, infracción y fecha son requeridos" });

  const r = await pool.query(`
    INSERT INTO boletas_conducta (estudiante_id, infraccion_id, asignacion_id, registrado_por, fecha, observacion)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [estudiante_id, infraccion_id, asignacion_id||null, req.session.usuario.id, fecha, observacion||""]);
  res.json({ ok: true, id: r.rows[0].id });
});

// ── ELIMINAR BOLETA ───────────────────────────────────────────────────────────
router.delete("/:id", canManage, async (req, res) => {
  await pool.query("DELETE FROM boletas_conducta WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── ASIGNACIONES DEL USUARIO ACTUAL (para selector de materia) ────────────────
router.get("/mis-asignaciones/:seccion_id", requireAuth, async (req, res) => {
  const uid = req.session.usuario.id;
  const r = await pool.query(`
    SELECT a.id, m.nombre AS materia_nombre, u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
    FROM asignaciones a
    JOIN materias m ON m.id = a.materia_id
    JOIN usuarios u ON u.id = a.profesor_id
    WHERE a.seccion_id = $1
    ORDER BY m.nombre
  `, [req.params.seccion_id]);
  res.json(r.rows);
});

module.exports = router;

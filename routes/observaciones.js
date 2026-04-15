const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

// Obtener observaciones de un estudiante
router.get("/estudiante/:id", requireAuth, async (req, res) => {
  const { desde, hasta } = req.query;
  let sql = `
    SELECT o.*, u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.rol
    FROM observaciones_diarias o
    JOIN usuarios u ON u.id = o.usuario_id
    WHERE o.estudiante_id = $1
  `;
  const params = [req.params.id];
  if (desde) { params.push(desde); sql += ` AND o.fecha >= $${params.length}`; }
  if (hasta) { params.push(hasta); sql += ` AND o.fecha <= $${params.length}`; }
  sql += " ORDER BY o.fecha DESC, o.created_at DESC";
  const r = await pool.query(sql, params);
  res.json(r.rows);
});

// Observaciones de un estudiante en una fecha específica
router.get("/estudiante/:id/fecha/:fecha", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT o.*, u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
    FROM observaciones_diarias o
    JOIN usuarios u ON u.id = o.usuario_id
    WHERE o.estudiante_id = $1 AND o.fecha = $2
    ORDER BY o.created_at DESC
  `, [req.params.id, req.params.fecha]);
  res.json(r.rows);
});

// Crear observación
router.post("/", requireAuth, async (req, res) => {
  const { estudiante_id, fecha, observacion } = req.body;
  if (!estudiante_id || !fecha || !observacion)
    return res.status(400).json({ error: "Todos los campos son requeridos" });
  const r = await pool.query(`
    INSERT INTO observaciones_diarias (estudiante_id, usuario_id, fecha, observacion)
    VALUES ($1, $2, $3, $4) RETURNING id
  `, [estudiante_id, req.session.usuario.id, fecha, observacion.trim()]);
  res.json({ ok: true, id: r.rows[0].id });
});

// Eliminar observación (solo quien la creó o admin)
router.delete("/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const r = await pool.query("SELECT usuario_id FROM observaciones_diarias WHERE id=$1", [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "No encontrada" });
  if (r.rows[0].usuario_id !== u.id && u.rol !== "admin")
    return res.status(403).json({ error: "Sin permisos" });
  await pool.query("DELETE FROM observaciones_diarias WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;

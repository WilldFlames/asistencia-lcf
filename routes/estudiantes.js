const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");

const canManage = requireRol("admin","auxiliar");

// ── LISTAR ────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  const { seccion_id, q } = req.query;
  let sql = `SELECT e.*, s.nombre AS seccion_nombre FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id WHERE e.activo=true`;
  const params = [];
  if (seccion_id) { params.push(seccion_id); sql += ` AND e.seccion_id=$${params.length}`; }
  if (q) { params.push(`%${q}%`); sql += ` AND (e.cedula ILIKE $${params.length} OR e.primer_apellido ILIKE $${params.length} OR e.nombre ILIKE $${params.length})`; }
  sql += " ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre";
  const r = await pool.query(sql, params);
  res.json(r.rows);
});

// ── CONSULTA POR CÉDULA (todos los docentes) ─────────────────
router.get("/consulta/:cedula", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.cedula=$1 AND e.activo=true
  `, [req.params.cedula.trim()]);
  if (!r.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
  const est = r.rows[0];
  const enc = await pool.query("SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC", [est.id]);
  res.json({ ...est, encargados: enc.rows });
});

// ── CREAR ─────────────────────────────────────────────────────
router.post("/", canManage, async (req, res) => {
  const { cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento, seccion_id, subgrupo } = req.body;
  if (!cedula||!nombre||!primer_apellido||!segundo_apellido)
    return res.status(400).json({ error: "Datos incompletos" });
  try {
    const r = await pool.query(`INSERT INTO estudiantes (cedula,nombre,primer_apellido,segundo_apellido,fecha_nacimiento,seccion_id,subgrupo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [cedula.trim(),nombre.trim(),primer_apellido.trim(),segundo_apellido.trim(),fecha_nacimiento||null,seccion_id||null,subgrupo||null]);
    res.json({ ok:true, id:r.rows[0].id });
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "Cédula ya registrada" });
    res.status(500).json({ error: e.message });
  }
});

// ── EDITAR (solo auxiliar/admin) ─────────────────────────────
router.put("/:id", canManage, async (req, res) => {
  const { nombre, primer_apellido, segundo_apellido, fecha_nacimiento, subgrupo } = req.body;
  await pool.query(`UPDATE estudiantes SET nombre=$1,primer_apellido=$2,segundo_apellido=$3,fecha_nacimiento=$4,subgrupo=$5 WHERE id=$6`,
    [nombre.trim(),primer_apellido.trim(),segundo_apellido.trim(),fecha_nacimiento||null,subgrupo||null,req.params.id]);
  res.json({ ok:true });
});

// ── CAMBIAR SECCIÓN (solo auxiliar/admin) ────────────────────
router.put("/:id/seccion", canManage, async (req, res) => {
  const { seccion_id, justificacion } = req.body;
  const estId = req.params.id;

  // Obtener info actual del estudiante
  const estR = await pool.query(`
    SELECT e.*, s.nombre AS sec_nombre FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.id=$1
  `, [estId]);
  if (!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
  const est = estR.rows[0];
  const seccionAnteriorId = est.seccion_id;
  const seccionAnteriorNombre = est.sec_nombre || "Sin sección";

  // Actualizar sección y guardar justificación
  await pool.query(
    "UPDATE estudiantes SET seccion_id=$1, justificacion_cambio_seccion=$2 WHERE id=$3",
    [seccion_id||null, justificacion||null, estId]
  );

  const secNombreNueva = seccion_id
    ? (await pool.query("SELECT nombre FROM secciones WHERE id=$1", [seccion_id])).rows[0]?.nombre
    : "Sin sección";

  const msgAnterior = `🔄 El estudiante ${est.primer_apellido} ${est.nombre} fue trasladado FUERA de la sección ${seccionAnteriorNombre}${justificacion ? ` — Motivo: ${justificacion}` : ""}.`;
  const msgNueva    = `🔄 El estudiante ${est.primer_apellido} ${est.nombre} fue trasladado a la sección ${secNombreNueva}${justificacion ? ` — Motivo: ${justificacion}` : ""}.`;

  // Notificar profesores de la sección ANTERIOR
  if (seccionAnteriorId) {
    const profsAnt = await pool.query(`
      SELECT DISTINCT profesor_id AS uid FROM asignaciones WHERE seccion_id=$1
      UNION SELECT profesor_id AS uid FROM seccion_guia WHERE seccion_id=$1 AND profesor_id IS NOT NULL
    `, [seccionAnteriorId]);
    for (const p of profsAnt.rows) {
      await pool.query("INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1,'cambio_seccion',$2)", [p.uid, msgAnterior]);
    }
  }

  // Notificar profesores de la sección NUEVA
  if (seccion_id) {
    const profsNueva = await pool.query(`
      SELECT DISTINCT profesor_id AS uid FROM asignaciones WHERE seccion_id=$1
      UNION SELECT profesor_id AS uid FROM seccion_guia WHERE seccion_id=$1 AND profesor_id IS NOT NULL
    `, [seccion_id]);
    for (const p of profsNueva.rows) {
      await pool.query("INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1,'cambio_seccion',$2)", [p.uid, msgNueva]);
    }
  }

  res.json({ ok: true });
});

// ── ELIMINAR (baja lógica) ─────────────────────────────────────
router.delete("/:id", canManage, async (req, res) => {
  await pool.query("UPDATE estudiantes SET activo=false WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;

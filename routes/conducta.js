const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");
const { notificarEstudiante } = require("../utils/push-familias");

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
      u.segundo_apellido AS prof_ap2,
      r.nombre AS reg_nombre,
      r.primer_apellido AS reg_ap1,
      r.segundo_apellido AS reg_ap2,
      r.rol AS reg_rol,
      ap.nombre AS apoyo_nombre,
      ap.primer_apellido AS apoyo_ap1,
      ap.segundo_apellido AS apoyo_ap2,
      ap.rol AS apoyo_rol
    FROM boletas_conducta b
    JOIN infracciones i ON i.id = b.infraccion_id
    LEFT JOIN asignaciones a ON a.id = b.asignacion_id
    LEFT JOIN materias m ON m.id = a.materia_id
    LEFT JOIN usuarios u ON u.id = a.profesor_id
    JOIN usuarios r ON r.id = b.registrado_por
    LEFT JOIN usuarios ap ON ap.id = b.usuario_apoyo_id
    WHERE b.estudiante_id = $1
  `;
  const params = [req.params.id];
  if (desde) { params.push(desde); sql += ` AND b.fecha >= $${params.length}`; }
  if (hasta) { params.push(hasta); sql += ` AND b.fecha <= $${params.length}`; }
  sql += " ORDER BY b.fecha DESC, b.created_at DESC";

  const r = await pool.query(sql, params);
  const totalRebajado = r.rows.reduce((s, b) => s + (b.puntos || 0), 0);
  const notaConduccion = Math.max(0, 100 - totalRebajado);

  res.json({ boletas: r.rows, totalRebajado, notaConducta: notaConduccion });
});

// ── REGISTRAR BOLETA ──────────────────────────────────────────────────────────
// Una boleta puede atribuirse a:
//   - Una asignación (materia + profesor)  → asignacion_id
//   - Un orientador/auxiliar/administrativo → usuario_apoyo_id
//   - Nadie en particular (la atiende solo el guía) → ambos null
// Son mutuamente excluyentes; si llegan los dos, ganan en orden: asignación primero.
router.post("/", canManage, async (req, res) => {
  const { estudiante_id, infraccion_id, asignacion_id, usuario_apoyo_id, fecha, observacion } = req.body;
  if (!estudiante_id || !infraccion_id || !fecha)
    return res.status(400).json({ error: "Estudiante, infracción y fecha son requeridos" });

  const asigFinal  = asignacion_id ? +asignacion_id : null;
  const apoyoFinal = (!asigFinal && usuario_apoyo_id) ? +usuario_apoyo_id : null;

  const r = await pool.query(`
    INSERT INTO boletas_conducta (estudiante_id, infraccion_id, asignacion_id, usuario_apoyo_id, registrado_por, fecha, observacion)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `, [estudiante_id, infraccion_id, asigFinal, apoyoFinal, req.session.usuario.id, fecha, observacion||""]);
  void notificarEstudiante(estudiante_id, {
    title: "Nueva boleta de conducta",
    body: "Se registró una boleta de conducta para {estudiante}. Ingrese al portal para revisar la información.",
    url: "/?app=familias&abrir=conducta",
    tag: `boleta-conducta-${r.rows[0].id}`,
  });
  res.json({ ok: true, id: r.rows[0].id });
});

// ── ELIMINAR BOLETA ───────────────────────────────────────────────────────────
router.delete("/:id", canManage, async (req, res) => {
  await pool.query("DELETE FROM boletas_conducta WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── ASIGNACIONES DEL USUARIO ACTUAL (para selector de materia) ────────────────
// Devuelve opciones para el selector "Asignar a" al registrar una boleta.
// Incluye:
//   - Asignaciones materia+profesor de la sección (lo de toda la vida).
//   - Personal de apoyo (orientadores, auxiliares, administrativos) sin materia,
//     para que también puedan figurar como quien atendió la boleta.
// El frontend agrupa por tipo con optgroup.
router.get("/mis-asignaciones/:seccion_id", requireAuth, async (req, res) => {
  const anio = await obtenerAnioActivo();
  // Asignaciones reales (profesor + materia en esa sección)
  const asig = await pool.query(`
    SELECT a.id, m.nombre AS materia_nombre,
           u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2
    FROM asignaciones a
    JOIN materias m ON m.id = a.materia_id
    JOIN usuarios u ON u.id = a.profesor_id
    WHERE a.seccion_id = $1 AND a.anio=$2
    ORDER BY m.nombre
  `, [req.params.seccion_id, anio]);

  // Personal de apoyo: orientadores, auxiliares, administrativos
  // (activos, sin importar la sección).
  let apoyo = { rows: [] };
  try {
    apoyo = await pool.query(`
      SELECT id, nombre, primer_apellido, segundo_apellido, rol
      FROM usuarios
      WHERE activo = true
        AND rol IN ('orientador','auxiliar','administrativo')
      ORDER BY rol, primer_apellido, nombre
    `);
  } catch (e) {
    // Si la columna 'activo' no existe en algún ambiente antiguo, cae al
    // catch y devolvemos lista vacía de apoyo en lugar de romper la pantalla.
    console.error("conducta mis-asignaciones apoyo:", e.message);
  }

  res.json({
    asignaciones: asig.rows,
    apoyo: apoyo.rows,
  });
});

module.exports = router;

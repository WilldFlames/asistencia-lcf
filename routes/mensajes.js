const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");

// ── HELPERS ───────────────────────────────────────────────────────────────────
const informeSelect = (whereClause) => `
  SELECT i.*,
    ur.nombre AS remit_nombre, ur.primer_apellido AS remit_ap1, ur.rol AS remit_rol,
    ud.nombre AS dest_nombre, ud.primer_apellido AS dest_ap1,
    e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
    s.nombre AS seccion_nombre
  FROM informes i
  JOIN usuarios ur ON ur.id=i.remitente_id
  JOIN usuarios ud ON ud.id=i.destinatario_id
  JOIN estudiantes e ON e.id=i.estudiante_id
  LEFT JOIN secciones s ON s.id=e.seccion_id
  ${whereClause}
  ORDER BY i.created_at DESC
`;

// ── BANDEJA DE ENTRADA ────────────────────────────────────────────────────────
router.get("/inbox", requireAuth, async (req, res) => {
  const r = await pool.query(informeSelect("WHERE i.destinatario_id=$1"), [req.session.usuario.id]);
  res.json(r.rows);
});

// ── ENVIADOS ──────────────────────────────────────────────────────────────────
router.get("/enviados", requireAuth, async (req, res) => {
  const r = await pool.query(informeSelect("WHERE i.remitente_id=$1"), [req.session.usuario.id]);
  res.json(r.rows);
});

// ── TODOS (admin) ─────────────────────────────────────────────────────────────
router.get("/todos", requireRol("admin"), async (req, res) => {
  const r = await pool.query(informeSelect(""));
  res.json(r.rows);
});

// ── INFORME COMPLETO DE UNA SECCIÓN ──────────────────────────────────────────
// Obtener todos los informes respondidos de un estudiante para compilar
router.get("/compilado/:estudiante_id", requireAuth, async (req, res) => {
  const r = await pool.query(informeSelect("WHERE i.estudiante_id=$1 AND i.respondido=true"), [req.params.estudiante_id]);
  res.json(r.rows);
});

// ── PROFESORES DE UNA SECCIÓN (para enviar informes masivos) ─────────────────
router.get("/profesores-seccion/:seccion_id", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT DISTINCT u.id, u.nombre, u.primer_apellido, u.segundo_apellido, u.rol,
      m.nombre AS materia_nombre
    FROM asignaciones a
    JOIN usuarios u ON u.id=a.profesor_id
    JOIN materias m ON m.id=a.materia_id
    WHERE a.seccion_id=$1 AND u.activo=true
    ORDER BY u.primer_apellido, u.nombre
  `, [req.params.seccion_id]);
  res.json(r.rows);
});

// ── ENVIAR INFORME A UN PROFESOR ─────────────────────────────────────────────
router.post("/", requireRol("profesor_guia","orientador","auxiliar"), async (req, res) => {
  const remitente_id = req.session.usuario.id;
  const { destinatario_id, estudiante_id, conducta, participacion, trabajos, nota_estimada, recomendaciones, observaciones } = req.body;
  if (!destinatario_id||!estudiante_id) return res.status(400).json({ error:"Datos incompletos" });
  const r = await pool.query(`
    INSERT INTO informes (remitente_id,destinatario_id,estudiante_id,conducta,participacion,trabajos,nota_estimada,recomendaciones,observaciones)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
  `, [remitente_id,destinatario_id,estudiante_id,conducta||"",participacion||"",trabajos||"",nota_estimada||"",recomendaciones||"",observaciones||""]);
  res.json({ ok:true, id:r.rows[0].id });
});

// ── ENVIAR INFORME A TODOS LOS PROFESORES DE UNA SECCIÓN ─────────────────────
router.post("/masivo", requireRol("profesor_guia","orientador","auxiliar"), async (req, res) => {
  const remitente_id = req.session.usuario.id;
  const { seccion_id, estudiante_id, conducta, participacion, trabajos, nota_estimada, recomendaciones, observaciones } = req.body;
  if (!seccion_id||!estudiante_id) return res.status(400).json({ error:"Datos incompletos" });

  // Obtener todos los profesores de la sección (excepto quien envía)
  const profsR = await pool.query(`
    SELECT DISTINCT a.profesor_id FROM asignaciones a
    WHERE a.seccion_id=$1 AND a.profesor_id!=$2
  `, [seccion_id, remitente_id]);

  if (!profsR.rows.length) return res.status(400).json({ error:"No hay profesores asignados a esta sección" });

  const insertados = [];
  for (const p of profsR.rows) {
    const r = await pool.query(`
      INSERT INTO informes (remitente_id,destinatario_id,estudiante_id,conducta,participacion,trabajos,nota_estimada,recomendaciones,observaciones)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [remitente_id,p.profesor_id,estudiante_id,conducta||"",participacion||"",trabajos||"",nota_estimada||"",recomendaciones||"",observaciones||""]);
    insertados.push(r.rows[0].id);
  }
  res.json({ ok:true, enviados:insertados.length });
});

// ── RESPONDER INFORME (con campos estructurados) ──────────────────────────────
router.put("/:id/responder", requireAuth, async (req, res) => {
  const uid = req.session.usuario.id;
  const { resp_asistencia, resp_trabajo_cotidiano, resp_tareas, resp_examenes, resp_comportamiento, resp_observaciones } = req.body;

  const inf = await pool.query("SELECT * FROM informes WHERE id=$1", [req.params.id]);
  if (!inf.rows.length) return res.status(404).json({ error:"No encontrado" });
  if (inf.rows[0].destinatario_id !== uid)
    return res.status(403).json({ error:"No autorizado" });

  // Construir respuesta de texto para compatibilidad
  const respTexto = [
    resp_asistencia ? `Asistencia: ${resp_asistencia}` : "",
    resp_trabajo_cotidiano ? `Trabajo Cotidiano: ${resp_trabajo_cotidiano}` : "",
    resp_tareas ? `Tareas: ${resp_tareas}` : "",
    resp_examenes ? `Exámenes/Proyectos: ${resp_examenes}` : "",
    resp_comportamiento ? `Comportamiento: ${resp_comportamiento}` : "",
    resp_observaciones ? `Observaciones: ${resp_observaciones}` : "",
  ].filter(Boolean).join("\n");

  await pool.query(`
    UPDATE informes SET
      resp_asistencia=$1, resp_trabajo_cotidiano=$2, resp_tareas=$3,
      resp_examenes=$4, resp_comportamiento=$5, resp_observaciones=$6,
      respuesta=$7, respondido=true, fecha_respuesta=NOW()
    WHERE id=$8
  `, [resp_asistencia||"", resp_trabajo_cotidiano||"", resp_tareas||"",
      resp_examenes||"", resp_comportamiento||"", resp_observaciones||"",
      respTexto, req.params.id]);

  // Notificar al remitente
  await pool.query(
    "INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1,'informe_respondido',$2)",
    [inf.rows[0].remitente_id, `✉️ El profesor respondió un informe de rendimiento.`]
  );

  res.json({ ok:true });
});

// ── MARCAR LEÍDO ──────────────────────────────────────────────────────────────
router.put("/:id/leer", requireAuth, async (req, res) => {
  await pool.query("UPDATE informes SET leido=true WHERE id=$1", [req.params.id]);
  res.json({ ok:true });
});

// ── NO LEÍDOS ─────────────────────────────────────────────────────────────────
router.get("/no-leidos", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT COUNT(*) AS c FROM informes WHERE destinatario_id=$1 AND leido=false",
    [req.session.usuario.id]
  );
  res.json({ count: parseInt(r.rows[0].c) });
});

module.exports = router;

const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");

// ── BANDEJA DE ENTRADA ────────────────────────────────────────────────────────
router.get("/inbox", requireAuth, async (req, res) => {
  const uid = req.session.usuario.id;
  const r = await pool.query(`
    SELECT i.*,
      u.nombre AS remit_nombre, u.primer_apellido AS remit_ap1,
      e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
      s.nombre AS seccion_nombre
    FROM informes i
    JOIN usuarios u ON u.id=i.remitente_id
    JOIN estudiantes e ON e.id=i.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE i.destinatario_id=$1
    ORDER BY i.created_at DESC
  `, [uid]);
  res.json(r.rows);
});

// ── ENVIADOS ──────────────────────────────────────────────────────────────────
router.get("/enviados", requireAuth, async (req, res) => {
  const uid = req.session.usuario.id;
  const r = await pool.query(`
    SELECT i.*,
      u.nombre AS dest_nombre, u.primer_apellido AS dest_ap1,
      e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
      s.nombre AS seccion_nombre
    FROM informes i
    JOIN usuarios u ON u.id=i.destinatario_id
    JOIN estudiantes e ON e.id=i.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE i.remitente_id=$1
    ORDER BY i.created_at DESC
  `, [uid]);
  res.json(r.rows);
});

// ── TODOS LOS INFORMES (admin) ────────────────────────────────────────────────
router.get("/todos", requireRol("admin"), async (req, res) => {
  const r = await pool.query(`
    SELECT i.*,
      ur.nombre AS remit_nombre, ur.primer_apellido AS remit_ap1,
      ud.nombre AS dest_nombre, ud.primer_apellido AS dest_ap1,
      e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
      s.nombre AS seccion_nombre
    FROM informes i
    JOIN usuarios ur ON ur.id=i.remitente_id
    JOIN usuarios ud ON ud.id=i.destinatario_id
    JOIN estudiantes e ON e.id=i.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    ORDER BY i.created_at DESC
  `);
  res.json(r.rows);
});

// ── ENVIAR INFORME ────────────────────────────────────────────────────────────
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

// ── RESPONDER INFORME ─────────────────────────────────────────────────────────
router.put("/:id/responder", requireAuth, async (req, res) => {
  const uid = req.session.usuario.id;
  const { respuesta } = req.body;
  // Solo el destinatario puede responder
  const inf = await pool.query("SELECT * FROM informes WHERE id=$1", [req.params.id]);
  if (!inf.rows.length) return res.status(404).json({ error:"No encontrado" });
  if (inf.rows[0].destinatario_id !== uid)
    return res.status(403).json({ error:"No autorizado" });
  await pool.query(`
    UPDATE informes SET respuesta=$1, respondido=true, fecha_respuesta=NOW() WHERE id=$2
  `, [respuesta, req.params.id]);
  res.json({ ok:true });
});

// ── MARCAR COMO LEÍDO ─────────────────────────────────────────────────────────
router.put("/:id/leer", requireAuth, async (req, res) => {
  await pool.query("UPDATE informes SET leido=true WHERE id=$1", [req.params.id]);
  res.json({ ok:true });
});

// ── CONTEO DE NO LEÍDOS (para badge) ─────────────────────────────────────────
router.get("/no-leidos", requireAuth, async (req, res) => {
  const uid = req.session.usuario.id;
  const r = await pool.query(
    "SELECT COUNT(*) AS c FROM informes WHERE destinatario_id=$1 AND leido=false",
    [uid]
  );
  res.json({ count: parseInt(r.rows[0].c) });
});

module.exports = router;

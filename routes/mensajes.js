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
// Obtener todos los informes respondidos de un estudiante para compilar.
// Incluye también las materias que el profesor enseña en la sección del estudiante,
// para que el informe compilado muestre "Prof. X — Materia Y".
router.get("/compilado/:estudiante_id", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT i.*,
      ur.nombre AS remit_nombre, ur.primer_apellido AS remit_ap1, ur.segundo_apellido AS remit_ap2, ur.rol AS remit_rol,
      ud.nombre AS dest_nombre, ud.primer_apellido AS dest_ap1, ud.segundo_apellido AS dest_ap2,
      e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
      e.cedula AS est_cedula,
      s.nombre AS seccion_nombre,
      (
        SELECT STRING_AGG(DISTINCT m.nombre, ', ' ORDER BY m.nombre)
        FROM asignaciones a
        JOIN materias m ON m.id = a.materia_id
        WHERE a.profesor_id = i.destinatario_id AND a.seccion_id = e.seccion_id
      ) AS materias_profesor
    FROM informes i
    JOIN usuarios ur ON ur.id=i.remitente_id
    JOIN usuarios ud ON ud.id=i.destinatario_id
    JOIN estudiantes e ON e.id=i.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE i.estudiante_id=$1 AND i.respondido=true
    ORDER BY ud.primer_apellido, ud.nombre, i.fecha_respuesta DESC
  `, [req.params.estudiante_id]);
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

  // Notificar al destinatario que recibió un informe nuevo.
  // Sin esto, los profes no se enteraban hasta entrar manualmente a "Mensajes".
  try {
    const estR = await pool.query(
      "SELECT nombre, primer_apellido, segundo_apellido FROM estudiantes WHERE id=$1",
      [estudiante_id]
    );
    const nombreEst = estR.rows[0]
      ? `${estR.rows[0].nombre||''} ${estR.rows[0].primer_apellido||''} ${estR.rows[0].segundo_apellido||''}`.replace(/\s+/g,' ').trim()
      : 'un estudiante';
    await pool.query(
      "INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'informe', $2)",
      [destinatario_id, `📋 Nuevo informe sobre ${nombreEst}. Revisalo en Mensajes.`]
    );
  } catch(e){ console.error("Notif informe:", e.message); }

  res.json({ ok:true, id:r.rows[0].id });
});

// ── ENVIAR INFORME A TODOS LOS PROFESORES DE UNA SECCIÓN ─────────────────────
router.post("/masivo", requireRol("profesor_guia","orientador","auxiliar"), async (req, res) => {
  const remitente_id = req.session.usuario.id;
  const { seccion_id, estudiante_id, conducta, participacion, trabajos, nota_estimada, recomendaciones, observaciones } = req.body;
  if (!seccion_id||!estudiante_id) return res.status(400).json({ error:"Datos incompletos" });

  // Obtener el subgrupo del estudiante (A, B o null)
  const estR = await pool.query(
    "SELECT subgrupo FROM estudiantes WHERE id=$1", [estudiante_id]
  );
  const subgrupoEst = estR.rows[0]?.subgrupo || null;

  // Obtener profesores de la sección que corresponden al subgrupo del estudiante:
  // - Si el estudiante tiene subgrupo A o B: solo profesores SIN subgrupo + profesores del mismo subgrupo
  // - Si el estudiante no tiene subgrupo: todos los profesores de la sección
  let profsQuery, profsParams;
  // Buscar profesores con asignación en esta sección.
  // IMPORTANTE: incluimos al remitente si también es profesor de materia
  // de esa misma sección (no solo guía). Es común que un guía dé materia
  // en su propia sección — debe poder responder el informe como profe de materia.
  // El DISTINCT garantiza que se cree UNA SOLA copia del informe por profesor,
  // aunque el guía tenga varias asignaciones (Mate + Esp por ejemplo).
  if (subgrupoEst) {
    profsQuery = `
      SELECT DISTINCT a.profesor_id FROM asignaciones a
      WHERE a.seccion_id=$1
        AND (a.subgrupo IS NULL OR a.subgrupo='' OR a.subgrupo=$2)
    `;
    profsParams = [seccion_id, subgrupoEst];
  } else {
    profsQuery = `
      SELECT DISTINCT a.profesor_id FROM asignaciones a
      WHERE a.seccion_id=$1
    `;
    profsParams = [seccion_id];
  }

  const profsR = await pool.query(profsQuery, profsParams);
  if (!profsR.rows.length) return res.status(400).json({ error:"No hay profesores asignados a esta sección" });

  // Obtener nombre del estudiante una sola vez para las notificaciones
  const estDataR = await pool.query(
    "SELECT nombre, primer_apellido, segundo_apellido FROM estudiantes WHERE id=$1",
    [estudiante_id]
  );
  const nombreEst = estDataR.rows[0]
    ? `${estDataR.rows[0].nombre||''} ${estDataR.rows[0].primer_apellido||''} ${estDataR.rows[0].segundo_apellido||''}`.replace(/\s+/g,' ').trim()
    : 'un estudiante';

  const insertados = [];
  for (const p of profsR.rows) {
    const r = await pool.query(`
      INSERT INTO informes (remitente_id,destinatario_id,estudiante_id,conducta,participacion,trabajos,nota_estimada,recomendaciones,observaciones)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [remitente_id,p.profesor_id,estudiante_id,conducta||"",participacion||"",trabajos||"",nota_estimada||"",recomendaciones||"",observaciones||""]);
    insertados.push(r.rows[0].id);
    // Notificar a cada profesor destinatario
    try {
      await pool.query(
        "INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'informe', $2)",
        [p.profesor_id, `📋 Nuevo informe sobre ${nombreEst}. Revisalo en Mensajes.`]
      );
    } catch(e){ console.error("Notif informe masivo:", e.message); }
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

// ── ELIMINAR INFORME (remitente, guía, orientador, auxiliar, admin) ──────────
router.delete("/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  // Verificar que sea el remitente o tenga rol admin/auxiliar
  const inf = await pool.query("SELECT remitente_id FROM informes WHERE id=$1", [req.params.id]);
  if(!inf.rows.length) return res.status(404).json({ error:"No encontrado" });
  const esRemitente = inf.rows[0].remitente_id === u.id;
  const puedeEliminar = esRemitente || ["admin","auxiliar"].includes(u.rol) ||
    (u.funciones_extra||[]).includes("profesor_guia") || (u.funciones_extra||[]).includes("orientador");
  if(!puedeEliminar) return res.status(403).json({ error:"Sin permisos para eliminar este informe" });
  await pool.query("DELETE FROM informes WHERE id=$1", [req.params.id]);
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

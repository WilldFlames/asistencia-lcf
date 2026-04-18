const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

// ── REPORTE ESTUDIANTE ────────────────────────────────────────
router.get("/estudiante/:id", requireAuth, async (req, res) => {
  const { desde, hasta } = req.query;
  const estR = await pool.query(`SELECT e.*, s.nombre AS seccion_nombre FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id WHERE e.id=$1`, [req.params.id]);
  if (!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });

  let dateFilter = "";
  const params = [req.params.id];
  if (desde) { params.push(desde); dateFilter += ` AND sa.fecha >= $${params.length}`; }
  if (hasta) { params.push(hasta); dateFilter += ` AND sa.fecha <= $${params.length}`; }

  const r = await pool.query(`
    SELECT m.nombre AS materia, u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1,
      SUM(sa.lecciones) AS total_lecciones,
      SUM(COALESCE(a.lecciones_ausentes, sa.lecciones)) FILTER (WHERE a.estado='A' AND NOT a.justificada) AS ausencias,
      SUM(COALESCE(a.lecciones_ausentes, sa.lecciones)) FILTER (WHERE a.estado='A' AND a.justificada) AS justificadas,
      SUM(sa.lecciones) FILTER (WHERE a.estado='T') AS tardias,
      JSON_AGG(JSON_BUILD_OBJECT(
        'fecha',sa.fecha,'lecciones',sa.lecciones,
        'lecciones_ausentes',a.lecciones_ausentes,
        'estado',a.estado,'justificada',a.justificada,
        'motivo',a.motivo,'asistencia_id',a.id
      ) ORDER BY sa.fecha) FILTER (WHERE a.estado IN ('A','T')) AS detalle
    FROM asistencia a
    JOIN sesiones_asistencia sa ON sa.id=a.sesion_id
    JOIN asignaciones asig ON asig.id=sa.asignacion_id
    JOIN materias m ON m.id=asig.materia_id
    JOIN usuarios u ON u.id=asig.profesor_id
    WHERE a.estudiante_id=$1 ${dateFilter}
    GROUP BY m.nombre, u.nombre, u.primer_apellido ORDER BY m.nombre
  `, params);

  // Observaciones del período
  let obsFilter = ""; const obsParams = [req.params.id];
  if (desde) { obsParams.push(desde); obsFilter += ` AND o.fecha >= $${obsParams.length}`; }
  if (hasta) { obsParams.push(hasta); obsFilter += ` AND o.fecha <= $${obsParams.length}`; }
  const obsR = await pool.query(`
    SELECT o.*, u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
    FROM observaciones_diarias o JOIN usuarios u ON u.id=o.usuario_id
    WHERE o.estudiante_id=$1 ${obsFilter} ORDER BY o.fecha DESC
  `, obsParams);

  const encR = await pool.query("SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC", [req.params.id]);
  res.json({ estudiante: estR.rows[0], materias: r.rows, encargados: encR.rows, observaciones: obsR.rows });
});

// ── ENVIAR REPORTE POR CORREO ─────────────────────────────────
router.post("/enviar-email/:estudiante_id", requireAuth, async (req, res) => {
  const { desde, hasta } = req.body;
  try {
    const nodemailer = require("nodemailer");
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(400).json({ error: "El sistema de correo no está configurado. Contacte al administrador." });
    }

    // Obtener datos
    const estR = await pool.query(`SELECT e.*, s.nombre AS seccion_nombre FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id WHERE e.id=$1`, [req.params.estudiante_id]);
    if (!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
    const est = estR.rows[0];

    const encR = await pool.query("SELECT * FROM encargados WHERE estudiante_id=$1 AND email!='' ORDER BY es_principal DESC", [req.params.estudiante_id]);
    if (!encR.rows.length) return res.status(400).json({ error: "El estudiante no tiene encargados con correo electrónico registrado." });

    let dateFilter = "";
    const params = [req.params.estudiante_id];
    if (desde) { params.push(desde); dateFilter += ` AND sa.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); dateFilter += ` AND sa.fecha <= $${params.length}`; }

    const matR = await pool.query(`
      SELECT m.nombre AS materia,
        SUM(sa.lecciones) AS total_lecciones,
        SUM(sa.lecciones) FILTER (WHERE a.estado='A' AND NOT a.justificada) AS ausencias,
        SUM(sa.lecciones) FILTER (WHERE a.estado='A' AND a.justificada) AS justificadas,
        SUM(sa.lecciones) FILTER (WHERE a.estado='T') AS tardias
      FROM asistencia a
      JOIN sesiones_asistencia sa ON sa.id=a.sesion_id
      JOIN asignaciones asig ON asig.id=sa.asignacion_id
      JOIN materias m ON m.id=asig.materia_id
      WHERE a.estudiante_id=$1 ${dateFilter}
      GROUP BY m.nombre ORDER BY m.nombre
    `, params);

    const remitente = req.session.usuario;
    const fmtF = d => { if(!d)return"—"; const dt=new Date(d+"T12:00:00"); return dt.toLocaleDateString("es-CR",{day:"2-digit",month:"2-digit",year:"numeric"}); };

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:#1a3a5c;color:#fff;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
          <h2 style="margin:0;">Liceo de Calle Fallas</h2>
          <p style="margin:4px 0;opacity:.8;font-size:13px;">Directora: Licda. Laura Cruz Jiménez</p>
          <h3 style="margin:12px 0 0;">Reporte de Asistencia</h3>
        </div>
        <div style="border:1px solid #e2e8f0;padding:20px;border-radius:0 0 8px 8px;">
          <p><strong>Estudiante:</strong> ${est.primer_apellido} ${est.segundo_apellido}, ${est.nombre}</p>
          <p><strong>Sección:</strong> ${est.seccion_nombre||"—"}</p>
          <p><strong>Período:</strong> ${desde?fmtF(desde):"Inicio"} al ${hasta?fmtF(hasta):"hoy"}</p>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:13px;">
            <thead>
              <tr style="background:#f1f5f9;">
                <th style="padding:8px;border:1px solid #e2e8f0;text-align:left;">Materia</th>
                <th style="padding:8px;border:1px solid #e2e8f0;">Lecciones</th>
                <th style="padding:8px;border:1px solid #e2e8f0;color:#dc2626;">Ausencias</th>
                <th style="padding:8px;border:1px solid #e2e8f0;color:#16a34a;">Justificadas</th>
                <th style="padding:8px;border:1px solid #e2e8f0;color:#d97706;">Tardías</th>
                <th style="padding:8px;border:1px solid #e2e8f0;">%</th>
              </tr>
            </thead>
            <tbody>
              ${matR.rows.map(m => `
                <tr>
                  <td style="padding:7px 8px;border:1px solid #e2e8f0;">${m.materia}</td>
                  <td style="padding:7px 8px;border:1px solid #e2e8f0;text-align:center;">${m.total_lecciones||0}</td>
                  <td style="padding:7px 8px;border:1px solid #e2e8f0;text-align:center;color:#dc2626;font-weight:bold;">${m.ausencias||0}</td>
                  <td style="padding:7px 8px;border:1px solid #e2e8f0;text-align:center;color:#16a34a;">${m.justificadas||0}</td>
                  <td style="padding:7px 8px;border:1px solid #e2e8f0;text-align:center;color:#d97706;">${m.tardias||0}</td>
                  <td style="padding:7px 8px;border:1px solid #e2e8f0;text-align:center;">${m.total_lecciones>0?Math.round((m.ausencias||0)/m.total_lecciones*100):0}%</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          <p style="margin-top:20px;font-size:12px;color:#64748b;">
            Enviado por: ${remitente.primer_apellido} ${remitente.nombre} — ${new Date().toLocaleDateString("es-CR")}
          </p>
        </div>
      </div>
    `;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    const destinatarios = encR.rows.map(e => e.email).filter(Boolean);
    await transporter.sendMail({
      from: `"Liceo de Calle Fallas" <${process.env.EMAIL_USER}>`,
      to: destinatarios.join(", "),
      subject: `Reporte de Asistencia — ${est.primer_apellido} ${est.nombre} (${est.seccion_nombre||""})`,
      html
    });

    res.json({ ok: true, enviado_a: destinatarios });
  } catch(e) { res.status(500).json({ error: "Error al enviar el correo: " + e.message }); }
});

// ── SECCIONES ACCESIBLES ──────────────────────────────────────
router.get("/mis-secciones", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const fx = u.funciones_extra || [];
  const esGuia      = u.rol === "profesor_guia" || fx.includes("profesor_guia");
  const esOrientador= u.rol === "orientador"    || fx.includes("orientador");

  if (u.rol === "admin" || u.rol === "auxiliar") {
    const r = await pool.query("SELECT * FROM secciones ORDER BY nivel, nombre");
    return res.json(r.rows);
  }
  if (esGuia) {
    const r = await pool.query("SELECT s.* FROM secciones s JOIN seccion_guia sg ON sg.seccion_id=s.id WHERE sg.profesor_id=$1 ORDER BY s.nivel,s.nombre", [u.id]);
    return res.json(r.rows);
  }
  if (esOrientador) {
    const r = await pool.query("SELECT DISTINCT s.* FROM secciones s JOIN seccion_orientador so ON so.seccion_id=s.id WHERE so.orientador_id=$1 ORDER BY s.nivel,s.nombre", [u.id]);
    return res.json(r.rows);
  }
  res.json([]);
});

router.get("/seccion/:seccion_id/estudiantes", requireAuth, async (req, res) => {
  const r = await pool.query(`SELECT id,cedula,nombre,primer_apellido,segundo_apellido FROM estudiantes WHERE seccion_id=$1 AND activo=true ORDER BY primer_apellido,segundo_apellido,nombre`, [req.params.seccion_id]);
  res.json(r.rows);
});

// ── DASHBOARD PROFESOR ───────────────────────────────────────────────────────
router.get("/dashboard-profesor", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const hoy = new Date().toISOString().slice(0,10);

  // 1. Asignaciones del profesor y si ya pasó lista hoy
  const asigs = await pool.query(`
    SELECT a.id, a.subgrupo, s.nombre AS seccion_nombre, m.nombre AS materia_nombre,
      sa.id AS sesion_hoy, sa.lecciones
    FROM asignaciones a
    JOIN secciones s ON s.id=a.seccion_id
    JOIN materias m ON m.id=a.materia_id
    LEFT JOIN sesiones_asistencia sa ON sa.asignacion_id=a.id AND sa.fecha=$2
    WHERE a.profesor_id=$1
    ORDER BY s.nombre, m.nombre
  `, [u.id, hoy]);

  // 2. Informes pendientes de responder
  const informesPendientes = await pool.query(`
    SELECT COUNT(*) AS c FROM informes
    WHERE destinatario_id=$1 AND respondido=false AND leido=false
  `, [u.id]);

  // 3. Ausencias frecuentes (estudiantes con más de 10 lecciones ausentes en el período)
  const fx = u.funciones_extra || [];
  const esGuia = u.rol==='profesor_guia' || fx.includes('profesor_guia');
  const esOrientador = u.rol==='orientador' || fx.includes('orientador');

  let ausenciasFrecuentes = [];
  let seccionId = null;

  if (esGuia) {
    const sg = await pool.query('SELECT seccion_id FROM seccion_guia WHERE profesor_id=$1 LIMIT 1', [u.id]);
    if (sg.rows.length) seccionId = sg.rows[0].seccion_id;
  } else if (esOrientador) {
    const so = await pool.query('SELECT seccion_id FROM seccion_orientador WHERE orientador_id=$1 LIMIT 1', [u.id]);
    if (so.rows.length) seccionId = so.rows[0].seccion_id;
  }

  if (seccionId) {
    const aus = await pool.query(`
      SELECT e.nombre, e.primer_apellido, e.segundo_apellido,
        COALESCE(SUM(COALESCE(ast.lecciones_ausentes, sa.lecciones)),0) AS total_ausencias
      FROM estudiantes e
      LEFT JOIN asistencia ast ON ast.estudiante_id=e.id AND ast.estado='A' AND ast.justificada=false
      LEFT JOIN sesiones_asistencia sa ON sa.id=ast.sesion_id
      WHERE e.seccion_id=$1 AND e.activo=true
      GROUP BY e.id, e.nombre, e.primer_apellido, e.segundo_apellido
      HAVING COALESCE(SUM(COALESCE(ast.lecciones_ausentes, sa.lecciones)),0) >= 10
      ORDER BY total_ausencias DESC
      LIMIT 10
    `, [seccionId]);
    ausenciasFrecuentes = aus.rows;
  } else {
    // Para profesores regulares, sus propios estudiantes
    const aus = await pool.query(`
      SELECT e.nombre, e.primer_apellido, e.segundo_apellido,
        COALESCE(SUM(COALESCE(ast.lecciones_ausentes, sa.lecciones)),0) AS total_ausencias,
        m.nombre AS materia_nombre
      FROM asignaciones a
      JOIN materias m ON m.id=a.materia_id
      JOIN estudiantes e ON e.seccion_id=a.seccion_id AND e.activo=true
      LEFT JOIN asistencia ast ON ast.estudiante_id=e.id AND ast.estado='A' AND ast.justificada=false
      LEFT JOIN sesiones_asistencia sa ON sa.id=ast.sesion_id AND sa.asignacion_id=a.id
      WHERE a.profesor_id=$1
      GROUP BY e.id, e.nombre, e.primer_apellido, e.segundo_apellido, m.nombre
      HAVING COALESCE(SUM(COALESCE(ast.lecciones_ausentes, sa.lecciones)),0) >= 10
      ORDER BY total_ausencias DESC
      LIMIT 10
    `, [u.id]);
    ausenciasFrecuentes = aus.rows;
  }

  // 4. Estado conducta de la sección (solo guía/orientador)
  let estadoConducta = null;
  if (seccionId) {
    const cond = await pool.query(`
      SELECT
        COUNT(DISTINCT e.id) AS total,
        COUNT(DISTINCT CASE WHEN (100 - COALESCE(rebajo,0)) < 60 THEN e.id END) AS criticos,
        COUNT(DISTINCT CASE WHEN (100 - COALESCE(rebajo,0)) < 80
          AND (100 - COALESCE(rebajo,0)) >= 60 THEN e.id END) AS en_riesgo
      FROM estudiantes e
      LEFT JOIN (
        SELECT bc.estudiante_id, SUM(i.puntos) AS rebajo
        FROM boletas_conducta bc JOIN infracciones i ON i.id=bc.infraccion_id
        GROUP BY bc.estudiante_id
      ) r ON r.estudiante_id=e.id
      WHERE e.seccion_id=$1 AND e.activo=true
    `, [seccionId]);
    estadoConducta = cond.rows[0];
  }

  // 5. Informes solicitados sin responder (guía/orientador)
  const informesSolicitados = await pool.query(`
    SELECT COUNT(*) AS c FROM informes
    WHERE remitente_id=$1 AND respondido=false
  `, [u.id]);

  res.json({
    asignaciones: asigs.rows,
    informesPendientes: parseInt(informesPendientes.rows[0].c),
    ausenciasFrecuentes,
    estadoConducta,
    informesSolicitados: parseInt(informesSolicitados.rows[0].c),
    esGuia, esOrientador, seccionId
  });
});

// ── REPORTE DE CUMPLIMIENTO (admin) ──────────────────────────────────────────
router.get("/cumplimiento", requireAuth, async (req, res) => {
  const { desde, hasta } = req.query;
  const hoy = new Date().toISOString().slice(0,10);
  const d = desde || hoy.slice(0,8) + '01';
  const h = hasta || hoy;

  // Asistencia por profesor: cuántas sesiones han pasado vs cuántas deberían
  const asistencia = await pool.query(`
    SELECT u.id, u.nombre, u.primer_apellido, u.segundo_apellido, u.rol,
      COUNT(DISTINCT sa.id) AS sesiones_registradas,
      COUNT(DISTINCT a.id) AS asignaciones_total
    FROM usuarios u
    LEFT JOIN asignaciones a ON a.profesor_id = u.id
    LEFT JOIN sesiones_asistencia sa ON sa.asignacion_id = a.id
      AND sa.fecha BETWEEN $1 AND $2
    WHERE u.activo = true AND u.rol IN ('profesor','profesor_guia','orientador')
    GROUP BY u.id, u.nombre, u.primer_apellido, u.segundo_apellido, u.rol
    ORDER BY u.primer_apellido, u.nombre
  `, [d, h]);

  // Conducta por sección: boletas registradas por guía
  const conducta = await pool.query(`
    SELECT u.id, u.nombre, u.primer_apellido, u.segundo_apellido,
      s.nombre AS seccion_nombre,
      COUNT(DISTINCT bc.id) AS boletas_registradas,
      COUNT(DISTINCT e.id) AS total_estudiantes
    FROM seccion_guia sg
    JOIN usuarios u ON u.id = sg.profesor_id
    JOIN secciones s ON s.id = sg.seccion_id
    LEFT JOIN estudiantes e ON e.seccion_id = s.id AND e.activo = true
    LEFT JOIN boletas_conducta bc ON bc.registrado_por = u.id
      AND bc.fecha BETWEEN $1 AND $2
    GROUP BY u.id, u.nombre, u.primer_apellido, u.segundo_apellido, s.nombre
    ORDER BY s.nombre
  `, [d, h]);

  res.json({ asistencia: asistencia.rows, conducta: conducta.rows, desde: d, hasta: h });
});

module.exports = router;

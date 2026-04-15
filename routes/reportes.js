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
  if (u.rol === "admin" || u.rol === "auxiliar") {
    const r = await pool.query("SELECT * FROM secciones ORDER BY nivel, nombre");
    return res.json(r.rows);
  }
  if (u.rol === "profesor_guia") {
    const r = await pool.query("SELECT s.* FROM secciones s JOIN seccion_guia sg ON sg.seccion_id=s.id WHERE sg.profesor_id=$1", [u.id]);
    return res.json(r.rows);
  }
  if (u.rol === "orientador") {
    const r = await pool.query("SELECT DISTINCT s.* FROM secciones s JOIN seccion_orientador so ON so.seccion_id=s.id WHERE so.orientador_id=$1 ORDER BY s.nivel,s.nombre", [u.id]);
    return res.json(r.rows);
  }
  res.json([]);
});

router.get("/seccion/:seccion_id/estudiantes", requireAuth, async (req, res) => {
  const r = await pool.query(`SELECT id,cedula,nombre,primer_apellido,segundo_apellido FROM estudiantes WHERE seccion_id=$1 AND activo=true ORDER BY primer_apellido,segundo_apellido,nombre`, [req.params.seccion_id]);
  res.json(r.rows);
});

module.exports = router;

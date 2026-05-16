const router = require("express").Router();
const { pool } = require("../db");
const { requireDocente } = require("../middleware/auth");

// ── MIS ASIGNACIONES ──────────────────────────────────────────────────────────
// Detecta el período lectivo actual según la fecha del servidor.
// Antes del 4-jul-2026 = I Período. Después = II Período.
function periodoActualNombre() {
  const hoy = new Date();
  return (hoy < new Date('2026-07-04T00:00:00')) ? 'I Período' : 'II Período';
}

router.get("/mis-asignaciones", requireDocente, async (req, res) => {
  const uid = req.session.usuario.id;
  // Solo mostrar asignaciones del PERÍODO ACTUAL para que el profe no se confunda
  // tomando asistencia en una asignación vieja. Las históricas existen en BD para reportes.
  const periodo = periodoActualNombre();
  const r = await pool.query(`
    SELECT a.id, a.lecciones_semana, a.subgrupo, a.periodo,
      s.nombre AS seccion_nombre, s.nivel,
      m.nombre AS materia_nombre,
      (SELECT COUNT(*) FROM sesiones_asistencia sa WHERE sa.asignacion_id=a.id) AS sesiones_total
    FROM asignaciones a
    JOIN secciones s ON s.id=a.seccion_id
    JOIN materias m ON m.id=a.materia_id
    WHERE a.profesor_id=$1 AND COALESCE(a.periodo,'I Período')=$2
    ORDER BY s.nombre, m.nombre
  `, [uid, periodo]);
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
  // Anti-cache: la asistencia es datos en vivo, nunca debe servirse desde caché
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  try {
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

  // DISTINCT ON requiere que la expresión coincida con el primer ORDER BY
  // Luego ordenamos alfabéticamente con una subconsulta
  let estQuery = `SELECT * FROM (
    SELECT DISTINCT ON (e.cedula) e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      false AS escapado
    FROM estudiantes e
    WHERE e.seccion_id=$1 AND e.activo=true AND (e.archivado=false OR e.archivado IS NULL)`;
  const estParams = [seccion_id];
  // Si la asignación tiene subgrupo → mostrar SOLO estudiantes de ese subgrupo
  // Si NO tiene subgrupo → el profe tiene el grupo completo → mostrar todos
  if (subgrupo && subgrupo.trim() !== '') {
    estParams.push(subgrupo.trim().toUpperCase());
    estQuery += ` AND UPPER(COALESCE(e.subgrupo,'')) = $${estParams.length}`;
  }
  estQuery += ` ORDER BY e.cedula) sub ORDER BY sub.primer_apellido, sub.segundo_apellido, sub.nombre`;
  const estR = await pool.query(estQuery, estParams);

  if (!sesR.rows.length) {
    // Sesión nueva → todos presentes y escapado=false por defecto
    return res.json({
      sesion: null,
      estudiantes: estR.rows.map(e => ({ ...e, escapado: false, estado:"P", justificada:false, motivo:"" }))
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
    escapado: asistMap[e.id]?.escapado || false,  // escapado por sesión, no del estudiante
    estado: asistMap[e.id]?.estado || "P",
    lecciones_ausentes: asistMap[e.id]?.lecciones_ausentes || null,
    lecciones_tardias:  asistMap[e.id]?.lecciones_tardias  || null,
    justificada: asistMap[e.id]?.justificada || false,
    motivo: asistMap[e.id]?.motivo || "",
    asistencia_id: asistMap[e.id]?.id || null
  }));

  res.json({ sesion, estudiantes });
  } catch(err) {
    console.error("GET asistencia error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GUARDAR ASISTENCIA ─────────────────────────────────────────────────────
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
      // lecciones_tardias: si es Tardía y no se especifica, usar 1 (comportamiento histórico).
      // Acepta valores 1..lecciones. Para P/A → NULL.
      const lecTar = r.estado === 'T'
        ? Math.min(Math.max(parseInt(r.lecciones_tardias) || 1, 1), lecciones)
        : null;
      await client.query(`
        INSERT INTO asistencia (sesion_id, estudiante_id, estado, lecciones_ausentes, lecciones_tardias, justificada, motivo, escapado)
        VALUES ($1,$2,$3,$4,$5,false,'',$6)
        ON CONFLICT (sesion_id, estudiante_id) DO UPDATE
          SET estado=$3, lecciones_ausentes=$4, lecciones_tardias=$5, escapado=$6
          -- NO resetear justificada ni boleta_ausencia_id al re-guardar
      `, [sesion_id, r.estudiante_id, r.estado, lecAus, lecTar, r.escapado || false]);
    }

    await client.query("COMMIT");

    // ── BOLETAS AUTOMÁTICAS para Guía y Orientación ──────────────────────────
    // Si la materia es de guía u orientación, generar boleta por ausencia injustificada
    try {
      const asigInfoR = await pool.query(`
        SELECT a.id, m.nombre AS materia, a.profesor_id AS prof_id,
          (
            -- Es guía/orientación si el profesor tiene ese rol
            EXISTS(SELECT 1 FROM usuarios u2 WHERE u2.id=a.profesor_id AND
              u2.rol IN ('profesor_guia','orientador'))
            OR
            -- O si el nombre de la materia contiene "guía" u "orientación"
            m.nombre ILIKE '%guía%' OR m.nombre ILIKE '%guia%' OR
            m.nombre ILIKE '%orientaci%'
          ) AS es_guia_ori
        FROM asignaciones a
        JOIN materias m ON m.id=a.materia_id
        WHERE a.id=$1
      `, [asignacion_id]);

      console.log("auto-boleta: materia=", asigInfoR.rows[0]?.materia, "es_guia_ori=", asigInfoR.rows[0]?.es_guia_ori);
      if (asigInfoR.rows[0]?.es_guia_ori) {
        // Get "Ausencias injustificadas" infraccion
        const infR = await pool.query(
          "SELECT id FROM infracciones WHERE tipo='leve' AND descripcion ILIKE '%Ausencias injustificadas%' LIMIT 1"
        );
        const infraccionId = infR.rows[0]?.id;

        console.log("auto-boleta: infraccionId=", infraccionId);
        if (infraccionId) {
          for (const reg of registros) {
            // Buscar por sesion_id + estudiante_id (reg.id no existe en el body)
            const existR = await pool.query(
              "SELECT id, boleta_ausencia_id FROM asistencia WHERE sesion_id=$1 AND estudiante_id=$2",
              [sesion_id, reg.estudiante_id]
            );
            const asistRow = existR.rows[0];
            if (!asistRow) continue;

            if (reg.estado === 'A' && !reg.justificada) {
              // Si ya tiene boleta no crear otra
              if (asistRow.boleta_ausencia_id) continue;
              const boletaR = await pool.query(`
                INSERT INTO boletas_conducta
                  (estudiante_id, infraccion_id, asignacion_id, registrado_por, fecha, observacion)
                VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
              `, [reg.estudiante_id, infraccionId, asignacion_id,
                  req.session.usuario.id, fecha,
                  'Boleta generada automáticamente por ausencia injustificada en Guía/Orientación.']);
              const boletaId = boletaR.rows[0].id;
              await pool.query(
                "UPDATE asistencia SET boleta_ausencia_id=$1 WHERE id=$2",
                [boletaId, asistRow.id]
              );

              // ── Notificar al profesor guía de la sección ──
              // Antes no se notificaba — el guía no se enteraba de la boleta automática.
              try {
                const guiaR = await pool.query(`
                  SELECT sg.profesor_id AS id,
                    e.primer_apellido, e.segundo_apellido, e.nombre,
                    s.nombre AS seccion_nombre
                  FROM seccion_guia sg
                  JOIN estudiantes e ON e.id=$1
                  LEFT JOIN secciones s ON s.id=e.seccion_id
                  WHERE sg.seccion_id = e.seccion_id`, [reg.estudiante_id]);
                for (const g of guiaR.rows) {
                  if (g.id === req.session.usuario.id) continue;  // no auto-notificar
                  await pool.query(`
                    INSERT INTO notificaciones (usuario_id, tipo, mensaje)
                    VALUES ($1, 'conducta', $2)
                  `, [
                    g.id,
                    `⚠️ Boleta automática — ${g.primer_apellido} ${g.segundo_apellido}, ${g.nombre} (${g.seccion_nombre||'sin sección'}): Ausencia injustificada en Guía/Orientación.`
                  ]);
                }
              } catch(notifErr){ console.error('notif auto-boleta:', notifErr.message); }
            } else {
              // Presente o justificado → eliminar boleta automática si existe
              if (asistRow.boleta_ausencia_id) {
                await pool.query("DELETE FROM boletas_conducta WHERE id=$1", [asistRow.boleta_ausencia_id]);
                await pool.query("UPDATE asistencia SET boleta_ausencia_id=NULL WHERE id=$1", [asistRow.id]);
              }
            }
          }
        }
      }
    } catch(autoBoletaErr) {
      console.error("auto-boleta error:", autoBoletaErr.message);
      // No fail the request for this
    }

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
  const asistId = parseInt(req.params.asistencia_id);
  if(!asistId) return res.status(400).json({ error:"ID de asistencia inválido" });

  try {
    // Get current asistencia record
    const aR = await pool.query("SELECT id, boleta_ausencia_id FROM asistencia WHERE id=$1", [asistId]);
    if (!aR.rows.length) return res.status(404).json({ error:"Registro de asistencia no encontrado (id: "+asistId+")" });
    const asist = aR.rows[0];

    // Update justificacion
    await pool.query(
      "UPDATE asistencia SET justificada=$1, motivo=$2 WHERE id=$3",
      [justificada === true || justificada === 'true', motivo||"", asistId]
    );

    // Si se justifica Y había boleta automática → eliminarla (sin fallar si no existe)
    if (justificada && asist.boleta_ausencia_id) {
      try {
        await pool.query("DELETE FROM boletas_conducta WHERE id=$1", [asist.boleta_ausencia_id]);
        await pool.query("UPDATE asistencia SET boleta_ausencia_id=NULL WHERE id=$1", [asistId]);
      } catch(boletaErr) {
        console.error("boleta delete error (no critical):", boletaErr.message);
      }
    }

    res.json({ ok:true });
  } catch(err) {
    console.error("justificar error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ELIMINAR SESIÓN (borra todos los registros del día) ───────────────────────
router.delete("/sesion/:sesion_id", requireDocente, async (req, res) => {
  await pool.query("DELETE FROM sesiones_asistencia WHERE id=$1", [req.params.sesion_id]);
  res.json({ ok:true });
});

module.exports = router;

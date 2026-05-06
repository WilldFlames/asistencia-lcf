const router = require("express").Router();
const { pool } = require("../db");
const { requireDocente } = require("../middleware/auth");

// ── MIS ASIGNACIONES ──────────────────────────────────────────────────────────
router.get("/mis-asignaciones", requireDocente, async (req, res) => {
  const uid = req.session.usuario.id;
  const r = await pool.query(`
    SELECT a.id, a.lecciones_semana, a.subgrupo,
      s.nombre AS seccion_nombre, s.nivel,
      m.nombre AS materia_nombre,
      (SELECT COUNT(*) FROM sesiones_asistencia sa WHERE sa.asignacion_id=a.id) AS sesiones_total
    FROM asignaciones a
    JOIN secciones s ON s.id=a.seccion_id
    JOIN materias m ON m.id=a.materia_id
    WHERE a.profesor_id=$1
    ORDER BY s.nombre, m.nombre
  `, [uid]);
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
      COALESCE(e.escapado, false) AS escapado
    FROM estudiantes e
    WHERE e.seccion_id=$1 AND e.activo=true AND (e.archivado=false OR e.archivado IS NULL)`;
  const estParams = [seccion_id];
  // Solo filtrar por subgrupo si la asignación tiene uno (A o B)
  // Si no tiene subgrupo = el profe tiene el grupo completo → mostrar todos
  if (subgrupo) {
    estParams.push(subgrupo);
    estQuery += ` AND (e.subgrupo=$${estParams.length} OR e.subgrupo IS NULL OR e.subgrupo='')`;
  }
  estQuery += ` ORDER BY e.cedula) sub ORDER BY sub.primer_apellido, sub.segundo_apellido, sub.nombre`;
  const estR = await pool.query(estQuery, estParams);

  if (!sesR.rows.length) {
    // Sesión vacía, todos presentes por defecto
    return res.json({
      sesion: null,
      estudiantes: estR.rows.map(e => ({ ...e, estado:"P", justificada:false, motivo:"" }))
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
    estado: asistMap[e.id]?.estado || "P",
    lecciones_ausentes: asistMap[e.id]?.lecciones_ausentes || null,
    justificada: asistMap[e.id]?.justificada || false,
    motivo: asistMap[e.id]?.motivo || "",
    asistencia_id: asistMap[e.id]?.id || null
  }));

  res.json({ sesion, estudiantes });
});

// ── GUARDAR ASISTENCIA ────────────────────────────────────────────────────────
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
      await client.query(`
        INSERT INTO asistencia (sesion_id, estudiante_id, estado, lecciones_ausentes, justificada, motivo)
        VALUES ($1,$2,$3,$4,false,'')
        ON CONFLICT (sesion_id, estudiante_id) DO UPDATE SET estado=$3, lecciones_ausentes=$4
      `, [sesion_id, r.estudiante_id, r.estado, lecAus]);
    }

    await client.query("COMMIT");

    // ── BOLETAS AUTOMÁTICAS para Guía y Orientación ──────────────────────────
    // Si la materia es de guía u orientación, generar boleta por ausencia injustificada
    try {
      const asigInfoR = await pool.query(`
        SELECT a.id, m.nombre AS materia, a.profesor_id AS prof_id,
          EXISTS(SELECT 1 FROM usuarios u2 WHERE u2.id=a.profesor_id AND
            u2.rol IN ('profesor_guia','orientador'))
          AS es_guia_ori
        FROM asignaciones a
        JOIN materias m ON m.id=a.materia_id
        WHERE a.id=$1
      `, [asignacion_id]);

      if (asigInfoR.rows[0]?.es_guia_ori) {
        // Get "Ausencias injustificadas" infraccion
        const infR = await pool.query(
          "SELECT id FROM infracciones WHERE tipo='leve' AND descripcion ILIKE '%Ausencias injustificadas%' LIMIT 1"
        );
        const infraccionId = infR.rows[0]?.id;

        if (infraccionId) {
          for (const reg of registros) {
            if (reg.estado === 'A' && !reg.justificada) {
              // Check if already has auto-boleta
              const existR = await pool.query(
                "SELECT id, boleta_ausencia_id FROM asistencia WHERE id=$1", [reg.id]
              );
              if (existR.rows[0]?.boleta_ausencia_id) continue; // already has boleta

              const asistId = existR.rows[0]?.id;
              if (!asistId) continue;

              // Create boleta
              const boletaR = await pool.query(`
                INSERT INTO boletas_conducta
                  (estudiante_id, infraccion_id, asignacion_id, registrado_por, fecha, observacion)
                VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
              `, [reg.estudiante_id, infraccionId, asignacion_id,
                  req.session.usuario.id, fecha,
                  'Boleta generada automáticamente por ausencia injustificada en clase de Guía/Orientación.']);

              const boletaId = boletaR.rows[0].id;

              // Link boleta to asistencia record
              await pool.query(
                "UPDATE asistencia SET boleta_ausencia_id=$1 WHERE id=$2",
                [boletaId, asistId]
              );
            } else if ((reg.estado === 'P' || reg.justificada) ) {
              // Student is present or justified → delete auto-boleta if exists
              const existR = await pool.query(
                "SELECT boleta_ausencia_id FROM asistencia WHERE id=$1", [reg.id]
              );
              const boletaId = existR.rows[0]?.boleta_ausencia_id;
              if (boletaId) {
                await pool.query("DELETE FROM boletas_conducta WHERE id=$1", [boletaId]);
                await pool.query("UPDATE asistencia SET boleta_ausencia_id=NULL WHERE id=$1", [reg.id]);
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

  // Get current asistencia record
  const aR = await pool.query("SELECT * FROM asistencia WHERE id=$1", [asistId]);
  if (!aR.rows.length) return res.status(404).json({ error:"No encontrado" });
  const asist = aR.rows[0];

  await pool.query(
    "UPDATE asistencia SET justificada=$1, motivo=$2 WHERE id=$3",
    [justificada, motivo||"", asistId]
  );

  // Si se justifica Y había boleta automática → eliminarla
  if (justificada && asist.boleta_ausencia_id) {
    await pool.query("DELETE FROM boletas_conducta WHERE id=$1", [asist.boleta_ausencia_id]);
    await pool.query("UPDATE asistencia SET boleta_ausencia_id=NULL WHERE id=$1", [asistId]);
  }

  res.json({ ok:true });
});

// ── ELIMINAR SESIÓN (borra todos los registros del día) ───────────────────────
router.delete("/sesion/:sesion_id", requireDocente, async (req, res) => {
  await pool.query("DELETE FROM sesiones_asistencia WHERE id=$1", [req.params.sesion_id]);
  res.json({ ok:true });
});

module.exports = router;

const router = require("express").Router();
const { pool } = require("../db");
const { requireDocente } = require("../middleware/auth");

// Detecta el período lectivo actual según la fecha del servidor.
// I Período: 23/feb – 3/jul, II Período: 20/jul – 9/dic. Fuera de eso, último cerrado.
function periodoActual() {
  const hoy = new Date();
  if (hoy < new Date('2026-07-04T00:00:00')) {
    return { nombre: 'I Período', desde: '2026-02-23', hasta: '2026-07-03' };
  }
  return { nombre: 'II Período', desde: '2026-07-20', hasta: '2026-12-09' };
}

// ── DATOS PRE-LLENADOS para el formulario ─────────────────────────────────────
// Devuelve la info del estudiante + cálculo de ausencias del período actual
// en la asignación del profesor que consulta. Si el profesor tiene varias
// materias con ese estudiante, devuelve todas y el frontend elige.
router.get("/datos/:estudiante_id", requireDocente, async (req, res) => {
  const estId = parseInt(req.params.estudiante_id);
  if (!estId) return res.status(400).json({ error: "estudiante_id inválido" });

  try {
    const p = periodoActual();
    const u = req.session.usuario;

    // Estudiante + sección + primer encargado
    const estR = await pool.query(`
      SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido, e.subgrupo,
        s.id AS seccion_id, s.nombre AS seccion_nombre
      FROM estudiantes e
      LEFT JOIN secciones s ON s.id=e.seccion_id
      WHERE e.id=$1 AND e.activo=true`, [estId]);
    if (!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
    const est = estR.rows[0];

    const encR = await pool.query(`
      SELECT nombre, primer_apellido, segundo_apellido, cedula, parentesco
      FROM encargados WHERE estudiante_id=$1
      ORDER BY es_principal DESC, id ASC LIMIT 1`, [estId]);

    // Asignaciones del docente que coinciden con la sección del estudiante.
    // Admin/auxiliar pueden ver todas las asignaciones de la sección.
    // EXCLUYE Guía y Orientación porque la carta de ausentismo no aplica a esas materias.
    const esAdminAux = ['admin','auxiliar'].includes(u.rol);
    const asigR = await pool.query(`
      SELECT a.id, m.nombre AS materia, a.lecciones_semana, a.subgrupo,
        u.id AS prof_id, u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2
      FROM asignaciones a
      JOIN materias m ON m.id=a.materia_id
      JOIN usuarios u ON u.id=a.profesor_id
      WHERE a.seccion_id=$1
        AND LOWER(m.nombre) NOT LIKE '%guía%'
        AND LOWER(m.nombre) NOT LIKE '%guia%'
        AND LOWER(m.nombre) NOT LIKE '%orientac%'
        ${esAdminAux ? '' : 'AND a.profesor_id=$2'}
      ORDER BY m.nombre`,
      esAdminAux ? [est.seccion_id] : [est.seccion_id, u.id]);

    // Filtrar adicionalmente por subgrupo: si la asignación tiene subgrupo, solo aplica
    // si el estudiante también tiene ese subgrupo (o no tiene asignado).
    // Si la asignación NO tiene subgrupo, aplica a todos los estudiantes de la sección.
    const estSubgrupo = (est.subgrupo || '').trim().toUpperCase();
    const asigsFiltradas = asigR.rows.filter(a => {
      const asigSubgrupo = (a.subgrupo || '').trim().toUpperCase();
      if (!asigSubgrupo) return true;        // Asignación al grupo completo
      if (!estSubgrupo) return true;         // Estudiante sin subgrupo (edge case)
      return asigSubgrupo === estSubgrupo;   // Coinciden
    });

    // Para cada asignación filtrada, calcular ausencias del período actual
    const asignaciones = [];
    for (const a of asigsFiltradas) {
      const stats = await pool.query(`
        SELECT
          COALESCE(SUM(sa.lecciones), 0) AS total_lecciones,
          COALESCE(SUM(COALESCE(ast.lecciones_ausentes, sa.lecciones))
            FILTER (WHERE ast.estado='A' AND NOT ast.justificada), 0) AS ausencias
        FROM sesiones_asistencia sa
        LEFT JOIN asistencia ast ON ast.sesion_id=sa.id AND ast.estudiante_id=$2
        WHERE sa.asignacion_id=$1
          AND sa.fecha BETWEEN $3 AND $4
      `, [a.id, estId, p.desde, p.hasta]);
      const totLec = parseInt(stats.rows[0].total_lecciones) || 0;
      const aus    = parseInt(stats.rows[0].ausencias) || 0;
      const pct    = totLec > 0 ? Math.round((aus / totLec) * 10000) / 100 : 0;
      asignaciones.push({
        asignacion_id: a.id,
        materia: a.materia,
        prof_id: a.prof_id,
        prof_nombre_completo: `${a.prof_ap1} ${a.prof_ap2}, ${a.prof_nombre}`.trim(),
        ausencias: aus,
        total_lecciones: totLec,
        porcentaje: pct
      });
    }

    res.json({
      estudiante: est,
      encargado: encR.rows[0] || null,
      asignaciones,
      periodo: p,
      docente: {
        id: u.id,
        nombre_completo: `${u.primer_apellido} ${u.segundo_apellido || ''}, ${u.nombre}`.trim()
      }
    });
  } catch (err) {
    console.error('cartas/datos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ESTUDIANTES QUE EL DOCENTE PUEDE USAR PARA UNA CARTA ─────────────────────
// Devuelve solo los estudiantes que el docente realmente da clase en esa sección,
// respetando subgrupos. Si el docente tiene asignación sin subgrupo (grupo completo),
// devuelve todos. Si tiene subgrupo "B", solo devuelve estudiantes con subgrupo "B" o sin subgrupo.
// EXCLUYE materias de Guía y Orientación (la carta de ausentismo no aplica a esas).
router.get("/estudiantes-disponibles/:seccion_id", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const secId = parseInt(req.params.seccion_id);
  if (!secId) return res.status(400).json({ error: "seccion_id inválido" });
  const esAdminAux = ['admin','auxiliar'].includes(u.rol);

  try {
    // Determinar qué subgrupos puede ver el docente en esa sección,
    // excluyendo materias de Guía y Orientación (case-insensitive).
    let subgrupos = null;  // null = sin restricción de subgrupo
    let tieneAsignacionAplicable = false;

    if (!esAdminAux) {
      const asigR = await pool.query(`
        SELECT a.subgrupo
        FROM asignaciones a
        JOIN materias m ON m.id=a.materia_id
        WHERE a.profesor_id=$1 AND a.seccion_id=$2
          AND LOWER(m.nombre) NOT LIKE '%guía%'
          AND LOWER(m.nombre) NOT LIKE '%guia%'
          AND LOWER(m.nombre) NOT LIKE '%orientac%'
      `, [u.id, secId]);

      if (!asigR.rows.length) {
        // No tiene materia aplicable en esa sección
        return res.json([]);
      }
      tieneAsignacionAplicable = true;

      // Si alguna asignación NO tiene subgrupo, el profe ve TODOS los estudiantes
      const tieneGrupoCompleto = asigR.rows.some(r => !r.subgrupo || !r.subgrupo.trim());
      if (!tieneGrupoCompleto) {
        // Recopilar todos los subgrupos donde tiene asignación
        subgrupos = [...new Set(asigR.rows.map(r => r.subgrupo.trim().toUpperCase()))];
      }
    }

    // Construir query de estudiantes
    let sql = `
      SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido, e.subgrupo
      FROM estudiantes e
      WHERE e.seccion_id=$1 AND e.activo=true AND (e.archivado=false OR e.archivado IS NULL)`;
    const params = [secId];

    if (subgrupos && subgrupos.length > 0) {
      // Filtrar por subgrupo: el estudiante debe tener uno de los subgrupos del profe,
      // o NO tener subgrupo asignado (caso edge: estudiante sin clasificar todavía)
      params.push(subgrupos);
      sql += ` AND (UPPER(COALESCE(e.subgrupo,'')) = ANY($${params.length}::text[]) OR COALESCE(e.subgrupo,'') = '')`;
    }

    sql += ` ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre`;
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('cartas/estudiantes-disponibles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SECCIONES DISPONIBLES (helper para el form) ──────────────────────────────
// El profesor regular solo ve secciones donde tiene asignación de materias REGULARES
// (excluye Guía y Orientación). Admin/aux ven todas.
router.get("/secciones-disponibles", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const esAdminAux = ['admin','auxiliar'].includes(u.rol);
  try {
    const r = await pool.query(
      esAdminAux
        ? `SELECT DISTINCT s.id, s.nombre, s.nivel FROM secciones s ORDER BY s.nivel, s.nombre`
        : `SELECT DISTINCT s.id, s.nombre, s.nivel FROM secciones s
           JOIN asignaciones a ON a.seccion_id=s.id
           JOIN materias m ON m.id=a.materia_id
           WHERE a.profesor_id=$1
             AND LOWER(m.nombre) NOT LIKE '%guía%'
             AND LOWER(m.nombre) NOT LIKE '%guia%'
             AND LOWER(m.nombre) NOT LIKE '%orientac%'
           ORDER BY s.nivel, s.nombre`,
      esAdminAux ? [] : [u.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('cartas/secciones error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GUARDAR carta emitida (registro histórico) ────────────────────────────────
router.post("/", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const { estudiante_id, asignacion_id, materia, ausencias,
          total_lecciones, porcentaje, observaciones } = req.body;
  if (!estudiante_id || !materia)
    return res.status(400).json({ error: "estudiante_id y materia son requeridos" });

  try {
    const p = periodoActual();
    const r = await pool.query(`
      INSERT INTO cartas_ausentismo
        (estudiante_id, asignacion_id, emitida_por, fecha, periodo, materia,
         ausencias, total_lecciones, porcentaje, observaciones)
      VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,$9)
      RETURNING id, fecha
    `, [estudiante_id, asignacion_id || null, u.id, p.nombre, materia,
        parseInt(ausencias) || 0, parseInt(total_lecciones) || 0,
        parseFloat(porcentaje) || 0, observaciones || '']);
    res.json({ ok: true, id: r.rows[0].id, fecha: r.rows[0].fecha });
  } catch (err) {
    console.error('cartas POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── LISTAR cartas emitidas (admin/aux ven todas, otros solo las suyas) ────────
router.get("/", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const esAdminAux = ['admin','auxiliar'].includes(u.rol);
  try {
    const r = await pool.query(`
      SELECT c.id, c.fecha, c.periodo, c.materia, c.ausencias, c.total_lecciones, c.porcentaje,
        e.id AS estudiante_id, e.nombre AS est_nombre,
        e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
        s.nombre AS seccion_nombre,
        u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
      FROM cartas_ausentismo c
      JOIN estudiantes e ON e.id=c.estudiante_id
      LEFT JOIN secciones s ON s.id=e.seccion_id
      JOIN usuarios u ON u.id=c.emitida_por
      ${esAdminAux ? '' : 'WHERE c.emitida_por=$1'}
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 200
    `, esAdminAux ? [] : [u.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('cartas GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── OBTENER una carta específica (para reimprimir desde el histórico) ─────────
router.get("/:id", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const esAdminAux = ['admin','auxiliar'].includes(u.rol);
  try {
    const r = await pool.query(`
      SELECT c.*,
        e.id AS estudiante_id, e.cedula AS est_cedula, e.nombre AS est_nombre,
        e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
        s.nombre AS seccion_nombre,
        u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2,
        enc.nombre AS enc_nombre, enc.primer_apellido AS enc_ap1, enc.segundo_apellido AS enc_ap2,
        enc.cedula AS enc_cedula, enc.parentesco AS enc_parentesco
      FROM cartas_ausentismo c
      JOIN estudiantes e ON e.id=c.estudiante_id
      LEFT JOIN secciones s ON s.id=e.seccion_id
      JOIN usuarios u ON u.id=c.emitida_por
      LEFT JOIN LATERAL (
        SELECT nombre, primer_apellido, segundo_apellido, cedula, parentesco
        FROM encargados WHERE estudiante_id=e.id
        ORDER BY es_principal DESC, id ASC LIMIT 1
      ) enc ON true
      WHERE c.id=$1 ${esAdminAux ? '' : 'AND c.emitida_por=$2'}
    `, esAdminAux ? [req.params.id] : [req.params.id, u.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Carta no encontrada" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('cartas GET id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

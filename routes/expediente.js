const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");

const canManage = requireRol("admin","auxiliar");

// ── BUSCAR ESTUDIANTE POR CÉDULA ──────────────────────────────────────────────
router.get("/buscar/:cedula", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre, s.nivel
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.cedula=$1
  `, [req.params.cedula.trim()]);
  if (!r.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
  const est = r.rows[0];

  // Encargados actuales
  const encs = await pool.query(
    "SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC",
    [est.id]
  );

  // Historial de años
  const hist = await pool.query(
    "SELECT * FROM expediente_historico WHERE estudiante_id=$1 ORDER BY anio DESC",
    [est.id]
  );

  // Matrícula registrada
  const mat = await pool.query(
    "SELECT m.*, s.nombre AS sec_nombre, u.nombre AS conf_nombre, u.primer_apellido AS conf_ap1 FROM matricula m LEFT JOIN secciones s ON s.id=m.seccion_id LEFT JOIN usuarios u ON u.id=m.confirmado_por WHERE m.estudiante_id=$1 ORDER BY m.anio DESC",
    [est.id]
  );

  res.json({ estudiante: est, encargados: encs.rows, historial: hist.rows, matriculas: mat.rows });
});

// ── ARCHIVAR AÑO ACTUAL ───────────────────────────────────────────────────────
// Toma una foto de todos los estudiantes activos con su sección y encargados
router.post("/archivar-anio", canManage, async (req, res) => {
  const { anio } = req.body;
  if (!anio) return res.status(400).json({ error: "El año es requerido" });
  const uid = req.session.usuario.id;

  const estudiantes = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre, s.nivel
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.activo=true
  `);

  let archivados = 0, omitidos = 0;
  for (const est of estudiantes.rows) {
    const encs = await pool.query("SELECT * FROM encargados WHERE estudiante_id=$1", [est.id]);
    try {
      await pool.query(`
        INSERT INTO expediente_historico (estudiante_id, anio, seccion_nombre, nivel, encargados_snap, archivado_por)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (estudiante_id, anio) DO UPDATE SET
          seccion_nombre=$3, nivel=$4, encargados_snap=$5, archivado_por=$6
      `, [est.id, anio, est.seccion_nombre||"", est.nivel||null, JSON.stringify(encs.rows), uid]);
      archivados++;
    } catch(e) { omitidos++; }
  }

  res.json({ ok: true, archivados, omitidos, anio });
});

// ── REGISTRAR MATRÍCULA ───────────────────────────────────────────────────────
router.post("/matricula", canManage, async (req, res) => {
  const { estudiante_id, anio, seccion_id, observaciones } = req.body;
  if (!estudiante_id || !anio) return res.status(400).json({ error: "Datos incompletos" });
  const uid = req.session.usuario.id;

  // Obtener nombre de sección
  let secNombre = "";
  if (seccion_id) {
    const s = await pool.query("SELECT nombre FROM secciones WHERE id=$1", [seccion_id]);
    secNombre = s.rows[0]?.nombre || "";
  }

  await pool.query(`
    INSERT INTO matricula (estudiante_id, anio, seccion_id, seccion_nombre, confirmado_por, observaciones)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (estudiante_id, anio) DO UPDATE SET
      seccion_id=$3, seccion_nombre=$4, confirmado_por=$5, observaciones=$6
  `, [estudiante_id, anio, seccion_id||null, secNombre, uid, observaciones||""]);

  res.json({ ok: true });
});

// ── APLICAR MATRÍCULAS (pasar sección de matrícula a estudiante) ──────────────
router.post("/aplicar-matriculas", canManage, async (req, res) => {
  const { anio } = req.body;
  if (!anio) return res.status(400).json({ error: "El año es requerido" });

  const mats = await pool.query(
    "SELECT * FROM matricula WHERE anio=$1 AND seccion_id IS NOT NULL", [anio]
  );

  let aplicados = 0;
  for (const m of mats.rows) {
    await pool.query("UPDATE estudiantes SET seccion_id=$1 WHERE id=$2", [m.seccion_id, m.estudiante_id]);
    aplicados++;
  }

  res.json({ ok: true, aplicados });
});

// ── ESTADÍSTICAS DE MATRÍCULA ─────────────────────────────────────────────────
router.get("/matricula/stats/:anio", canManage, async (req, res) => {
  const total = await pool.query("SELECT COUNT(*) AS c FROM estudiantes WHERE activo=true");
  const matriculados = await pool.query("SELECT COUNT(*) AS c FROM matricula WHERE anio=$1", [req.params.anio]);
  const pendientes = parseInt(total.rows[0].c) - parseInt(matriculados.rows[0].c);
  res.json({
    total: parseInt(total.rows[0].c),
    matriculados: parseInt(matriculados.rows[0].c),
    pendientes
  });
});

module.exports = router;

const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol, tieneRol } = require("../middleware/auth");

// Quién puede pasar lista: cocinera, admin
const canRegistrar = requireRol("admin","cocinera","orientador");
// Quién puede imprimir reportes: admin, comité comedor
function requireComedor(req, res, next){
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error:"No autorizado" });
  if(u.rol==="admin") return next();
  if(u.rol==="cocinera") return next();
  // Verificar si es comité de comedor
  pool.query("SELECT 1 FROM comedor_comite WHERE usuario_id=$1", [u.id])
    .then(r => r.rows.length ? next() : res.status(403).json({ error:"Sin permisos" }))
    .catch(() => res.status(403).json({ error:"Sin permisos" }));
}

// ── OBTENER ESTUDIANTES DEL COMEDOR (todos activos) ─────────────────
router.get("/estudiantes", requireAuth, async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0,10);
  const seccionId = req.query.seccion_id || null;
  const whereSeccion = seccionId ? "AND e.seccion_id=$2" : "";
  const params = seccionId ? [fecha, seccionId] : [fecha];
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.becado, s.nombre AS seccion_nombre,
      ca.id AS asistencia_id, ca.registrado_por
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN comedor_asistencia ca ON ca.estudiante_id=e.id AND ca.fecha=$1
    WHERE e.activo=true AND (e.archivado=false OR e.archivado IS NULL) ${whereSeccion}
    ORDER BY e.becado DESC, e.primer_apellido, e.segundo_apellido, e.nombre
  `, params);
  res.json(r.rows);
});

// ── ESCANEO DE CÉDULA (cocinera / admin) ────────────────────────────
router.post("/escaneo", canRegistrar, async (req, res) => {
  const { cedula } = req.body;
  if(!cedula) return res.status(400).json({ error:"Cédula requerida" });
  const fecha = new Date().toISOString().slice(0,10);
  const hora  = new Date().toLocaleTimeString("es-CR",{hour:"2-digit",minute:"2-digit"});

  // Buscar estudiante
  const estR = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.cedula=$1 AND e.activo=true
  `, [cedula.trim()]);

  if(!estR.rows.length) return res.status(404).json({ error:"Estudiante no encontrado en el sistema" });
  const est = estR.rows[0];

  // Verificar si ya comió hoy
  const ya = await pool.query("SELECT id FROM comedor_asistencia WHERE estudiante_id=$1 AND fecha=$2", [est.id, fecha]);
  const nuevo = ya.rows.length === 0;

  if(nuevo){
    await pool.query(`
      INSERT INTO comedor_asistencia (estudiante_id, fecha, tipo, registrado_por)
      VALUES ($1,$2,$3,$4)
    `, [est.id, fecha, est.becado ? 'becado' : 'regular', req.session.usuario.id]);
  }

  res.json({ ok:true, nuevo, hora, estudiante: est });
});


router.post("/asistencia", canRegistrar, async (req, res) => {
  const { fecha, estudiante_ids } = req.body;
  if(!fecha || !Array.isArray(estudiante_ids))
    return res.status(400).json({ error:"Datos incompletos" });
  const uid = req.session.usuario.id;

  // Get becado status for each student
  const ests = await pool.query(
    "SELECT id, becado FROM estudiantes WHERE id = ANY($1::int[])",
    [estudiante_ids]
  );
  const becadoMap = {};
  ests.rows.forEach(e => becadoMap[e.id] = e.becado);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Delete existing for this date
    await client.query("DELETE FROM comedor_asistencia WHERE fecha=$1", [fecha]);
    // Insert new records
    for(const id of estudiante_ids){
      await client.query(`
        INSERT INTO comedor_asistencia (estudiante_id, fecha, tipo, registrado_por)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (estudiante_id, fecha) DO UPDATE SET tipo=$3, registrado_por=$4
      `, [id, fecha, becadoMap[id] ? 'becado' : 'regular', uid]);
    }
    await client.query("COMMIT");
    res.json({ ok: true, registrados: estudiante_ids.length });
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── OBTENER ASISTENCIA DE UN DÍA ────────────────────────────────────
router.get("/asistencia/:fecha", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT ca.*, e.nombre, e.primer_apellido, e.segundo_apellido, e.cedula, e.becado,
      s.nombre AS seccion_nombre
    FROM comedor_asistencia ca
    JOIN estudiantes e ON e.id=ca.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE ca.fecha=$1
    ORDER BY e.becado DESC, e.primer_apellido, e.nombre
  `, [req.params.fecha]);
  res.json(r.rows);
});

// ── REPORTE POR PERÍODO ─────────────────────────────────────────────
router.get("/reporte", requireComedor, async (req, res) => {
  const { desde, hasta } = req.query;
  if(!desde||!hasta) return res.status(400).json({ error:"Fechas requeridas" });

  const resumen = await pool.query(`
    SELECT ca.fecha,
      COUNT(CASE WHEN e.becado THEN 1 END) AS becados,
      COUNT(CASE WHEN NOT e.becado THEN 1 END) AS regulares,
      COUNT(*) AS total
    FROM comedor_asistencia ca
    JOIN estudiantes e ON e.id=ca.estudiante_id
    WHERE ca.fecha BETWEEN $1 AND $2
    GROUP BY ca.fecha ORDER BY ca.fecha
  `, [desde, hasta]);

  res.json({ resumen: resumen.rows });
});

// ── GESTIÓN COMITÉ DE COMEDOR ────────────────────────────────────────
// GET: cualquier usuario puede verificar si pertenece al comité
router.get("/comite", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT cc.*, u.nombre, u.primer_apellido, u.segundo_apellido, u.cedula, u.rol, u.id AS usuario_id
    FROM comedor_comite cc JOIN usuarios u ON u.id=cc.usuario_id
  `);
  res.json(r.rows);
});

router.post("/comite", requireRol("admin"), async (req, res) => {
  const { usuario_id } = req.body;
  await pool.query("DELETE FROM comedor_comite"); // solo 1 a la vez
  await pool.query("INSERT INTO comedor_comite (usuario_id) VALUES ($1)", [usuario_id]);
  res.json({ ok: true });
});

router.delete("/comite/:id", requireRol("admin"), async (req, res) => {
  await pool.query("DELETE FROM comedor_comite WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;

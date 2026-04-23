const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol, tieneRol } = require("../middleware/auth");

// Fecha actual en Costa Rica (UTC-6)
function fechaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60; // minutos
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  return new Date(localMs).toISOString().slice(0,10);
}
// Hora actual en Costa Rica
function horaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  const local = new Date(localMs);
  const h = String(local.getUTCHours()).padStart(2,'0');
  const m = String(local.getUTCMinutes()).padStart(2,'0');
  return `${h}:${m}`;
}

// Quién puede registrar escaneo: cocinera, admin
const canRegistrar = requireRol("admin","cocinera");

// Quién puede ver reportes: admin, comité comedor, auxiliar
function requireComedor(req, res, next){
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error:"No autorizado" });
  if(u.rol==="admin" || u.rol==="cocinera" || u.rol==="auxiliar") return next();
  pool.query("SELECT 1 FROM comedor_comite WHERE usuario_id=$1", [u.id])
    .then(r => r.rows.length ? next() : res.status(403).json({ error:"Sin permisos" }))
    .catch(() => res.status(403).json({ error:"Sin permisos" }));
}

// ── ESTUDIANTES DEL COMEDOR (con estado de asistencia del día) ───────
router.get("/estudiantes", requireAuth, async (req, res) => {
  const fecha = req.query.fecha || fechaCR();
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

// ── ESCANEO DE CÉDULA (cocinera / admin) ─────────────────────────────
router.post("/escaneo", canRegistrar, async (req, res) => {
  const { cedula } = req.body;
  if(!cedula) return res.status(400).json({ error:"Cédula requerida" });
  const fecha = fechaCR();   // ← Fecha Costa Rica
  const hora  = horaCR();    // ← Hora Costa Rica

  const estR = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.cedula=$1 AND e.activo=true AND (e.archivado=false OR e.archivado IS NULL)
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

// ── ESTADÍSTICAS DEL ESCÁNER (cocinera/admin) ───────────────────────
router.get("/stats/:fecha", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN e.becado THEN 1 END) AS becados,
      COUNT(CASE WHEN NOT e.becado THEN 1 END) AS regulares
    FROM comedor_asistencia ca
    JOIN estudiantes e ON e.id=ca.estudiante_id
    WHERE ca.fecha=$1
  `, [req.params.fecha]);
  res.json(r.rows[0]||{total:0,becados:0,regulares:0});
});

// ── ASISTENCIA DEL DÍA COMPLETA (reporte) ───────────────────────────
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

// ── REPORTE POR PERÍODO ──────────────────────────────────────────────
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
router.get("/comite", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT cc.*, u.nombre, u.primer_apellido, u.segundo_apellido, u.cedula, u.rol, u.id AS usuario_id
    FROM comedor_comite cc JOIN usuarios u ON u.id=cc.usuario_id
  `);
  res.json(r.rows);
});

router.post("/comite", requireRol("admin"), async (req, res) => {
  const { usuario_id } = req.body;
  await pool.query("DELETE FROM comedor_comite");
  await pool.query("INSERT INTO comedor_comite (usuario_id) VALUES ($1)", [usuario_id]);
  res.json({ ok: true });
});

router.delete("/comite/:id", requireRol("admin"), async (req, res) => {
  await pool.query("DELETE FROM comedor_comite WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── ACTUALIZAR BECAS (orientador) ────────────────────────────────────
router.post("/actualizar-becas", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const fx = u.funciones_extra || [];
  const puede = u.rol==="orientador" || fx.includes("orientador") || u.rol==="admin" || u.rol==="auxiliar";
  if(!puede) return res.status(403).json({ error:"Sin permisos" });

  const { ids_con_beca, ids_sin_beca } = req.body;
  if(!Array.isArray(ids_con_beca)||!Array.isArray(ids_sin_beca))
    return res.status(400).json({ error:"Datos inválidos" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if(ids_con_beca.length)
      await client.query("UPDATE estudiantes SET becado=true WHERE id=ANY($1::int[])", [ids_con_beca]);
    if(ids_sin_beca.length)
      await client.query("UPDATE estudiantes SET becado=false WHERE id=ANY($1::int[])", [ids_sin_beca]);
    await client.query("COMMIT");
    res.json({ ok:true, con_beca: ids_con_beca.length, sin_beca: ids_sin_beca.length });
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;

const express = require("express");
const router  = express.Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const ROLES_MEDIDAS = ["admin","auxiliar","orientador","secretaria","administrativo","profesor_guia"];

function canAccess(req, res, next){
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error:"No autorizado" });
  if(ROLES_MEDIDAS.includes(u.rol)) return next();
  const coordinador=(u.funciones_extra||[]).includes("coordinador");
  if(coordinador && req.body?.tipo==="educacion_hibrida") return next();
  pool.query("SELECT 1 FROM funciones_institucionales WHERE usuario_id=$1 AND tipo='coordinador'",[u.id])
    .then(r=>r.rows.length && req.body?.tipo==="educacion_hibrida" ? next() : res.status(403).json({error:"Sin permisos"}))
    .catch(()=>res.status(403).json({error:"Sin permisos"}));
}

const fechaCR = () => new Date(new Date().toLocaleString('en-US',{timeZone:'America/Costa_Rica'})).toISOString().slice(0,10);

// ── LISTAR medidas activas (para asistencia - todos los que tienen medida activa hoy) ───
router.get("/activas", requireAuth, async (req, res) => {
  const hoy = fechaCR();
  const r = await pool.query(`
    SELECT m.id, m.tipo, m.observacion, m.creado_por,
      m.fecha_inicio::text AS fecha_inicio, m.fecha_fin::text AS fecha_fin,
      m.estudiante_id,
      e.nombre, e.primer_apellido, e.segundo_apellido, e.cedula,
      s.nombre AS seccion_nombre, s.id AS seccion_id,
      u.nombre AS creado_nombre, u.primer_apellido AS creado_ap1
    FROM medidas_estudiantiles m
    JOIN estudiantes e ON e.id=m.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN usuarios u ON u.id=m.creado_por
    WHERE m.fecha_inicio <= $1::date AND m.fecha_fin >= $1::date
    ORDER BY m.tipo, e.primer_apellido, e.segundo_apellido, e.nombre
  `, [hoy]);
  res.json(r.rows);
});

// ── LISTAR por tipo ──────────────────────────────────────────────────────────
router.get("/tipo/:tipo", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT m.*, e.nombre, e.primer_apellido, e.segundo_apellido, e.cedula,
      s.nombre AS seccion_nombre,
      u.nombre AS creado_nombre, u.primer_apellido AS creado_ap1
    FROM medidas_estudiantiles m
    JOIN estudiantes e ON e.id=m.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN usuarios u ON u.id=m.creado_por
    WHERE m.tipo=$1
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre, m.fecha_fin DESC
  `, [req.params.tipo]);
  res.json(r.rows);
});

// ── CREAR medida ─────────────────────────────────────────────────────────────
router.post("/", canAccess, async (req, res) => {
  const { estudiante_id, tipo, fecha_inicio, fecha_fin, observacion } = req.body;
  if(!estudiante_id||!tipo||!fecha_inicio||!fecha_fin)
    return res.status(400).json({ error:"Todos los campos son requeridos" });
  if(fecha_inicio > fecha_fin)
    return res.status(400).json({ error:"La fecha de inicio no puede ser posterior a la fecha de fin." });
  const r = await pool.query(`
    INSERT INTO medidas_estudiantiles (estudiante_id,tipo,fecha_inicio,fecha_fin,observacion,creado_por)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
  `, [estudiante_id, tipo, fecha_inicio, fecha_fin, observacion||'', req.session.usuario.id]);
  res.json({ ok:true, id:r.rows[0].id });
});

// ── ELIMINAR medida ──────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
  const u=req.session.usuario;
  if(!ROLES_MEDIDAS.includes(u.rol)){
    const medida=await pool.query("SELECT tipo FROM medidas_estudiantiles WHERE id=$1",[req.params.id]);
    const coordinador=(u.funciones_extra||[]).includes("coordinador") ||
      (await pool.query("SELECT 1 FROM funciones_institucionales WHERE usuario_id=$1 AND tipo='coordinador'",[u.id])).rows.length>0;
    if(!medida.rows.length) return res.status(404).json({error:"Registro no encontrado"});
    if(!coordinador || medida.rows[0].tipo!=="educacion_hibrida") return res.status(403).json({error:"Sin permisos"});
  }
  await pool.query("DELETE FROM medidas_estudiantiles WHERE id=$1", [req.params.id]);
  res.json({ ok:true });
});

// ── MEDIDAS de un estudiante específico ──────────────────────────────────────
router.get("/estudiante/:id", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT m.*, u.nombre AS creado_nombre, u.primer_apellido AS creado_ap1
    FROM medidas_estudiantiles m
    LEFT JOIN usuarios u ON u.id=m.creado_por
    WHERE m.estudiante_id=$1
    ORDER BY m.fecha_fin DESC
  `, [req.params.id]);
  res.json(r.rows);
});

module.exports = router;

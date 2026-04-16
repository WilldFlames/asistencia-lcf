const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { requireRol } = require("../middleware/auth");
const onlyAdmin = requireRol("admin");

// ── USUARIOS ──────────────────────────────────────────────────
router.get("/usuarios", onlyAdmin, async (req, res) => {
  const r = await pool.query(
    "SELECT id,cedula,nombre,primer_apellido,segundo_apellido,email,rol,activo,primer_login FROM usuarios ORDER BY primer_apellido,nombre"
  );
  res.json(r.rows);
});

router.post("/usuarios", onlyAdmin, async (req, res) => {
  const { cedula, nombre, primer_apellido, segundo_apellido, email, rol } = req.body;
  if (!cedula||!nombre||!primer_apellido||!segundo_apellido||!rol)
    return res.status(400).json({ error: "Todos los campos son requeridos" });
  try {
    // Contraseña inicial = cédula, primer_login = true
    const hash = await bcrypt.hash(cedula.trim(), 10);
    const r = await pool.query(`
      INSERT INTO usuarios (cedula,nombre,primer_apellido,segundo_apellido,email,password_hash,rol,primer_login)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id
    `, [cedula.trim(),nombre.trim(),primer_apellido.trim(),segundo_apellido.trim(),email||null,hash,rol]);
    res.json({ ok:true, id:r.rows[0].id });
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "La cédula ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/usuarios/:id", onlyAdmin, async (req, res) => {
  const { nombre, primer_apellido, segundo_apellido, email, rol, activo } = req.body;
  try {
    await pool.query(`UPDATE usuarios SET nombre=$1,primer_apellido=$2,segundo_apellido=$3,email=$4,rol=$5,activo=$6 WHERE id=$7`,
      [nombre,primer_apellido,segundo_apellido,email||null,rol,activo,req.params.id]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Reiniciar contraseña → vuelve a ser la cédula, obliga cambio
router.put("/usuarios/:id/reset-password", onlyAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT cedula FROM usuarios WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    const hash = await bcrypt.hash(r.rows[0].cedula, 10);
    await pool.query("UPDATE usuarios SET password_hash=$1, primer_login=true WHERE id=$2", [hash, req.params.id]);
    res.json({ ok: true, mensaje: "Contraseña reiniciada. El usuario deberá cambiarla al ingresar." });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MATERIAS ──────────────────────────────────────────────────
router.get("/materias", async (req, res) => {
  const r = await pool.query("SELECT * FROM materias ORDER BY nombre");
  res.json(r.rows);
});

router.post("/materias", onlyAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: "Nombre requerido" });
  try {
    const r = await pool.query("INSERT INTO materias (nombre) VALUES ($1) RETURNING *", [nombre.trim()]);
    res.json(r.rows[0]);
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "Materia ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.delete("/materias/:id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM materias WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── SECCIONES ─────────────────────────────────────────────────
router.get("/secciones", async (req, res) => {
  const r = await pool.query(`
    SELECT s.*,
      u.nombre AS guia_nombre, u.primer_apellido AS guia_ap1, u.id AS guia_id,
      o.id AS orient_id, o.nombre AS orient_nombre, o.primer_apellido AS orient_ap1
    FROM secciones s
    LEFT JOIN seccion_guia sg ON sg.seccion_id=s.id
    LEFT JOIN usuarios u ON u.id=sg.profesor_id
    LEFT JOIN (SELECT so.seccion_id, so.orientador_id FROM seccion_orientador so) so2 ON so2.seccion_id=s.id
    LEFT JOIN usuarios o ON o.id=so2.orientador_id
    ORDER BY s.nivel, s.nombre
  `);
  res.json(r.rows);
});

router.put("/secciones/:id/guia", onlyAdmin, async (req, res) => {
  const { profesor_id } = req.body;
  if (!profesor_id) return res.json({ ok: true });
  // Validar que no sea también orientador
  const esOrient = await pool.query("SELECT 1 FROM seccion_orientador WHERE orientador_id=$1 LIMIT 1", [profesor_id]);
  if (esOrient.rows.length > 0)
    return res.status(400).json({ error: "Este profesor ya está asignado como Orientador. Un profesor solo puede tener una función extra (guía O orientador, no ambas)." });
  await pool.query(`
    INSERT INTO seccion_guia (seccion_id,profesor_id) VALUES ($1,$2)
    ON CONFLICT (seccion_id) DO UPDATE SET profesor_id=$2
  `, [req.params.id, profesor_id]);
  res.json({ ok: true });
});

router.post("/secciones/:id/orientador", onlyAdmin, async (req, res) => {
  const { orientador_id } = req.body;
  if (!orientador_id) return res.json({ ok: true });
  // Validar que no sea también guía
  const esGuia = await pool.query("SELECT 1 FROM seccion_guia WHERE profesor_id=$1 LIMIT 1", [orientador_id]);
  if (esGuia.rows.length > 0)
    return res.status(400).json({ error: "Este profesor ya está asignado como Profesor Guía. Un profesor solo puede tener una función extra (guía O orientador, no ambas)." });
  await pool.query("DELETE FROM seccion_orientador WHERE seccion_id=$1", [req.params.id]);
  await pool.query("INSERT INTO seccion_orientador (seccion_id, orientador_id) VALUES ($1,$2)", [req.params.id, orientador_id]);
  res.json({ ok: true });
});

router.delete("/secciones/:seccion_id/orientador/:orientador_id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM seccion_orientador WHERE seccion_id=$1 AND orientador_id=$2", [req.params.seccion_id, req.params.orientador_id]);
  res.json({ ok: true });
});

// ── ASIGNACIONES ──────────────────────────────────────────────
router.get("/asignaciones", onlyAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT a.*, u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.rol AS prof_rol,
      s.nombre AS seccion_nombre, m.nombre AS materia_nombre
    FROM asignaciones a
    JOIN usuarios u ON u.id=a.profesor_id
    JOIN secciones s ON s.id=a.seccion_id
    JOIN materias m ON m.id=a.materia_id
    ORDER BY u.primer_apellido, s.nombre, m.nombre
  `);
  res.json(r.rows);
});

router.post("/asignaciones", onlyAdmin, async (req, res) => {
  const { profesor_id, seccion_id, materia_id, lecciones_semana, subgrupo } = req.body;
  if (!profesor_id||!seccion_id||!materia_id) return res.status(400).json({ error: "Datos incompletos" });
  try {
    const r = await pool.query(`INSERT INTO asignaciones (profesor_id,seccion_id,materia_id,lecciones_semana,subgrupo) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [profesor_id,seccion_id,materia_id,lecciones_semana||4,subgrupo||null]);
    res.json({ ok:true, id:r.rows[0].id });
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "Asignación ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.delete("/asignaciones/:id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM asignaciones WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

router.get("/profesores", async (req, res) => {
  const r = await pool.query(`SELECT id,cedula,nombre,primer_apellido,segundo_apellido,rol FROM usuarios WHERE rol IN ('profesor','profesor_guia','orientador') AND activo=true ORDER BY primer_apellido,nombre`);
  res.json(r.rows);
});

module.exports = router;

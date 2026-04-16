const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");

router.post("/login", async (req, res) => {
  const { cedula, password } = req.body;
  if (!cedula || !password) return res.status(400).json({ error: "Datos incompletos" });
  try {
    const r = await pool.query("SELECT * FROM usuarios WHERE cedula=$1 AND activo=true", [cedula.trim()]);
    if (!r.rows.length) return res.status(401).json({ error: "Cédula o contraseña incorrectos" });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Cédula o contraseña incorrectos" });

    // Verificar función extra: guía O orientador (no ambas)
    const esGuia = await pool.query("SELECT 1 FROM seccion_guia WHERE profesor_id=$1 LIMIT 1", [user.id]);
    const funciones_extra = [];
    if (esGuia.rows.length > 0) {
      funciones_extra.push("profesor_guia");
    } else {
      // Solo verificar orientador si no es guía
      const esOrientador = await pool.query("SELECT 1 FROM seccion_orientador WHERE orientador_id=$1 LIMIT 1", [user.id]);
      if (esOrientador.rows.length > 0) funciones_extra.push("orientador");
    }

    req.session.usuario = {
      id: user.id,
      cedula: user.cedula,
      nombre: user.nombre,
      primer_apellido: user.primer_apellido,
      segundo_apellido: user.segundo_apellido,
      rol: user.rol,
      primer_login: user.primer_login,
      funciones_extra  // roles adicionales por asignación de sección
    };
    res.json({ ok: true, usuario: req.session.usuario });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post("/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  if (req.session && req.session.usuario)
    return res.json({ autenticado: true, usuario: req.session.usuario });
  res.json({ autenticado: false });
});

router.post("/cambiar-password", async (req, res) => {
  if (!req.session?.usuario) return res.status(401).json({ error: "No autorizado" });
  const { password_actual, password_nuevo } = req.body;
  if (!password_actual || !password_nuevo)
    return res.status(400).json({ error: "Datos incompletos" });
  if (password_nuevo.length < 6)
    return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });
  try {
    const r = await pool.query("SELECT password_hash FROM usuarios WHERE id=$1", [req.session.usuario.id]);
    const ok = await bcrypt.compare(password_actual, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "La contraseña actual es incorrecta" });
    const hash = await bcrypt.hash(password_nuevo, 10);
    await pool.query("UPDATE usuarios SET password_hash=$1, primer_login=false WHERE id=$2", [hash, req.session.usuario.id]);
    req.session.usuario.primer_login = false;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

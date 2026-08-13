const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const {
  createRateLimiter,
  regenerateSession,
  saveSession,
} = require("../middleware/security");

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiados intentos de ingreso. Espere 15 minutos e intente nuevamente.",
});

async function obtenerFuncionesExtra(usuarioId) {
  const funciones = [];
  const esGuia = await pool.query("SELECT 1 FROM seccion_guia WHERE profesor_id=$1 LIMIT 1", [usuarioId]);
  if (esGuia.rows.length > 0) funciones.push("profesor_guia");
  else {
    const esOrientador = await pool.query("SELECT 1 FROM seccion_orientador WHERE orientador_id=$1 LIMIT 1", [usuarioId]);
    if (esOrientador.rows.length > 0) funciones.push("orientador");
  }
  const institucionales = await pool.query(
    "SELECT tipo FROM funciones_institucionales WHERE usuario_id=$1 ORDER BY tipo",
    [usuarioId]
  );
  for (const fila of institucionales.rows) {
    if (!funciones.includes(fila.tipo)) funciones.push(fila.tipo);
  }
  return funciones;
}

router.post("/login", loginLimiter, async (req, res) => {
  const { cedula, password } = req.body;
  if (!cedula || !password) return res.status(400).json({ error: "Datos incompletos" });
  try {
    const r = await pool.query("SELECT * FROM usuarios WHERE cedula=$1 AND activo=true", [cedula.trim()]);
    if (!r.rows.length) return res.status(401).json({ error: "Cédula o contraseña incorrectos" });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Cédula o contraseña incorrectos" });

    const funciones_extra = await obtenerFuncionesExtra(user.id);

    const usuarioSesion = {
      id: user.id,
      cedula: user.cedula,
      nombre: user.nombre,
      primer_apellido: user.primer_apellido,
      segundo_apellido: user.segundo_apellido,
      rol: user.rol,
      primer_login: user.primer_login,
      funciones_extra  // roles adicionales por asignación de sección
    };
    await regenerateSession(req);
    req.session.usuario = usuarioSesion;
    await saveSession(req);
    loginLimiter.reset(req);
    res.json({ ok: true, usuario: usuarioSesion });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post("/logout", (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie("lcf.sid");
    res.json({ ok: true });
  });
});

router.get("/me", async (req, res) => {
  if (req.session && req.session.usuario) {
    try {
      const vigente=await pool.query(`SELECT id,cedula,nombre,primer_apellido,segundo_apellido,rol,primer_login
        FROM usuarios WHERE id=$1 AND activo=true AND COALESCE(eliminado,false)=false`,[req.session.usuario.id]);
      if(!vigente.rows.length){
        return req.session.destroy(()=>{res.clearCookie("lcf.sid");res.json({autenticado:false});});
      }
      req.session.usuario={...vigente.rows[0],funciones_extra:await obtenerFuncionesExtra(vigente.rows[0].id)};
      await saveSession(req);
    } catch(e) { console.error("actualizar funciones de sesión:", e.message); }
    return res.json({ autenticado: true, usuario: req.session.usuario });
  }
  res.json({ autenticado: false });
});

router.post("/cambiar-password", async (req, res) => {
  if (!req.session?.usuario) return res.status(401).json({ error: "No autorizado" });
  const { password_actual, password_nuevo } = req.body;
  if (!password_actual || !password_nuevo)
    return res.status(400).json({ error: "Datos incompletos" });
  if (password_nuevo.length < 10)
    return res.status(400).json({ error: "La nueva contraseña debe tener al menos 10 caracteres" });
  try {
    const r = await pool.query("SELECT password_hash FROM usuarios WHERE id=$1", [req.session.usuario.id]);
    const ok = await bcrypt.compare(password_actual, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "La contraseña actual es incorrecta" });
    const hash = await bcrypt.hash(password_nuevo, 10);
    await pool.query("UPDATE usuarios SET password_hash=$1, primer_login=false WHERE id=$2", [hash, req.session.usuario.id]);
    const usuarioSesion = { ...req.session.usuario, primer_login: false };
    await regenerateSession(req);
    req.session.usuario = usuarioSesion;
    await saveSession(req);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

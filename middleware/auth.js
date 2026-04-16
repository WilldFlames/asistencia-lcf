// Verificar si el usuario tiene un rol o función extra
function tieneRol(usuario, roles) {
  if (!usuario) return false;
  if (roles.includes(usuario.rol)) return true;
  // También verificar funciones extra (guía u orientador por asignación de sección)
  if (usuario.funciones_extra && usuario.funciones_extra.some(f => roles.includes(f))) return true;
  return false;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.usuario) return next();
  return res.status(401).json({ error: "No autorizado" });
}

function requireRol(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.usuario)
      return res.status(401).json({ error: "No autorizado" });
    if (!tieneRol(req.session.usuario, roles))
      return res.status(403).json({ error: "Sin permisos para esta acción" });
    next();
  };
}

function requireDocente(req, res, next) {
  const docentes = ["admin","profesor","profesor_guia","orientador"];
  if (!req.session || !req.session.usuario)
    return res.status(401).json({ error: "No autorizado" });
  if (!tieneRol(req.session.usuario, docentes))
    return res.status(403).json({ error: "Sin permisos" });
  next();
}

module.exports = { requireAuth, requireRol, requireDocente, tieneRol };

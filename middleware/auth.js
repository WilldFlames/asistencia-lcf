function requireAuth(req, res, next) {
  if (req.session && req.session.usuario) return next();
  return res.status(401).json({ error: "No autorizado" });
}

function requireRol(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.usuario)
      return res.status(401).json({ error: "No autorizado" });
    if (!roles.includes(req.session.usuario.rol))
      return res.status(403).json({ error: "Sin permisos para esta acción" });
    next();
  };
}

// Roles docentes: todos los que pasan lista
function requireDocente(req, res, next) {
  const docentes = ["admin","profesor","profesor_guia","orientador"];
  if (!req.session || !req.session.usuario)
    return res.status(401).json({ error: "No autorizado" });
  if (!docentes.includes(req.session.usuario.rol))
    return res.status(403).json({ error: "Sin permisos" });
  next();
}

module.exports = { requireAuth, requireRol, requireDocente };

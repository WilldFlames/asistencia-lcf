const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { LECCIONES } = require("./horarios");
const {
  createRateLimiter,
  regenerateSession,
  saveSession,
} = require("../middleware/security");

const loginPadresLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiados intentos de ingreso. Espere 15 minutos e intente nuevamente.",
});

// ── Helpers Costa Rica ─────────────────────────────────────────────────────
function fechaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  return new Date(localMs).toISOString().slice(0,10);
}
function anioCR(){ return parseInt(fechaCR().slice(0,4)); }
function limpiarCedula(c){ return String(c||'').replace(/[\s\-.\/\\]/g,''); }

// Rangos de período del año (mismas fechas del CONTEXTO)
function rangosPeriodo(anio){
  return {
    I:  { desde: `${anio}-02-23`, hasta: `${anio}-07-03` },
    II: { desde: `${anio}-07-20`, hasta: `${anio}-12-09` },
  };
}

// ── Hijos asociados a una cédula de encargado ─────────────────────────────
async function hijosDe(cedula){
  const ced = limpiarCedula(cedula);
  const r = await pool.query(`
    SELECT DISTINCT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.seccion_id, s.nombre AS seccion_nombre
    FROM encargados enc
    JOIN estudiantes e ON e.id = enc.estudiante_id
    LEFT JOIN secciones s ON s.id = e.seccion_id
    WHERE REPLACE(REPLACE(REPLACE(enc.cedula,'-',''),'.',''),' ','') = $1
      AND enc.cedula IS NOT NULL AND enc.cedula <> ''
      AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
    ORDER BY e.primer_apellido, e.nombre
  `, [ced]);
  return r.rows;
}

// ── Middleware: sesión de padre válida + sesión única ─────────────────────
async function requirePadre(req, res, next){
  const p = req.session && req.session.padre;
  if(!p) return res.status(401).json({ error: "No autorizado" });
  try {
    const r = await pool.query("SELECT sid_activo, activo FROM padres_acceso WHERE cedula=$1", [p.cedula]);
    if(!r.rows.length || !r.rows[0].activo)
      return res.status(401).json({ error: "Acceso deshabilitado" });
    if(r.rows[0].sid_activo !== req.sessionID){
      // Alguien inició sesión en otro dispositivo con esta cédula → esta sesión muere
      req.session.destroy(()=>{});
      return res.status(401).json({ error: "Se inició sesión en otro dispositivo. Esta sesión se cerró." });
    }
    next();
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

// Verifica que el estudiante pertenezca al padre de la sesión
async function hijoDelPadre(req, res, next){
  const hijos = await hijosDe(req.session.padre.cedula);
  const hijo = hijos.find(h => h.id === parseInt(req.params.id));
  if(!hijo) return res.status(403).json({ error: "Estudiante no asociado a su cuenta" });
  req.hijo = hijo;
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
//  AUTENTICACIÓN
// ═══════════════════════════════════════════════════════════════════════════

router.post("/login", loginPadresLimiter, async (req, res) => {
  const { cedula, password } = req.body;
  if(!cedula || !password) return res.status(400).json({ error: "Cédula y contraseña requeridas" });
  const ced = limpiarCedula(cedula);

  // 1. Debe ser encargado de al menos un estudiante activo
  const hijos = await hijosDe(ced);
  if(!hijos.length)
    return res.status(404).json({ error: "Esta cédula no está registrada como encargado de ningún estudiante activo. Verificá en la institución que su cédula esté en el expediente." });

  // 2. ¿Esta cédula también pertenece a personal del liceo?
  //    Si sí, se valida con la contraseña de personal (docente/guía/etc.).
  //    Así una docente que además es madre entra al portal con SU MISMA
  //    contraseña de docente — sin tener que llevar dos contraseñas.
  const usuR = await pool.query(
    "SELECT id, password_hash, activo FROM usuarios WHERE cedula=$1", [ced]);
  const esPersonal = usuR.rows.length > 0;

  let primerLogin = false;

  if(esPersonal){
    // Validar contra password de personal
    if(!usuR.rows[0].activo)
      return res.status(403).json({ error: "Su cuenta de personal está inactiva. Contacte a la institución." });
    const ok = await bcrypt.compare(password, usuR.rows[0].password_hash);
    if(!ok) return res.status(401).json({ error: "Contraseña incorrecta. Como docente/personal del liceo, use la MISMA contraseña con la que ingresa al sistema como funcionario(a)." });
    // No creamos ni tocamos padres_acceso: el personal usa su propia cuenta.
    // Aun así registramos el sid_activo para que la sesión única funcione.
    await pool.query(`
      INSERT INTO padres_acceso (cedula, password_hash, primer_login)
      VALUES ($1, $2, false)
      ON CONFLICT (cedula) DO UPDATE SET primer_login = false
    `, [ced, usuR.rows[0].password_hash]);
  } else {
    // 3. NO es personal: flujo normal de padres (cédula como contraseña inicial)
    let acc = await pool.query("SELECT * FROM padres_acceso WHERE cedula=$1", [ced]);
    if(!acc.rows.length){
      if(password.trim() !== ced)
        return res.status(401).json({ error: "Contraseña incorrecta. Si es su primer ingreso, use su número de cédula como contraseña." });
      const hash = await bcrypt.hash(ced, 10);
      acc = await pool.query(`
        INSERT INTO padres_acceso (cedula, password_hash, primer_login) VALUES ($1,$2,true)
        ON CONFLICT (cedula) DO UPDATE SET cedula=EXCLUDED.cedula RETURNING *
      `, [ced, hash]);
    } else {
      if(!acc.rows[0].activo) return res.status(403).json({ error: "Acceso deshabilitado. Contacte a la institución." });
      const ok = await bcrypt.compare(password, acc.rows[0].password_hash);
      if(!ok) return res.status(401).json({ error: "Contraseña incorrecta" });
    }
    primerLogin = acc.rows[0].primer_login;
  }

  // 4. Nombre del encargado (del primer registro que lo tenga)
  const encR = await pool.query(`
    SELECT nombre, primer_apellido, segundo_apellido FROM encargados
    WHERE REPLACE(REPLACE(REPLACE(cedula,'-',''),'.',''),' ','') = $1 LIMIT 1
  `, [ced]);
  const enc = encR.rows[0] || { nombre: "", primer_apellido: "", segundo_apellido: "" };

  // 5. Registrar sesión (única): el sid nuevo invalida cualquier sesión anterior
  const padreSesion = { cedula: ced, nombre: enc.nombre, primer_apellido: enc.primer_apellido, segundo_apellido: enc.segundo_apellido, es_personal: esPersonal };
  await regenerateSession(req);
  req.session.padre = padreSesion;
  await saveSession(req);
  await pool.query("UPDATE padres_acceso SET sid_activo=$1 WHERE cedula=$2", [req.sessionID, ced]);

  loginPadresLimiter.reset(req);
  res.json({ ok: true, primer_login: primerLogin, es_personal: esPersonal, padre: padreSesion, hijos });
});

router.post("/cambiar-password", requirePadre, async (req, res) => {
  const { password_actual, password_nuevo } = req.body;
  if(!password_nuevo || password_nuevo.length < 6)
    return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });
  const ced = req.session.padre.cedula;
  // Si es también personal del liceo, su contraseña la maneja el sistema de
  // usuarios (no la puede cambiar desde el portal de padres — debería hacerlo
  // desde su perfil como docente).
  if(req.session.padre.es_personal){
    return res.status(400).json({ error: "Como docente/personal del liceo, la contraseña se cambia desde su cuenta como funcionario(a), no desde el portal de padres." });
  }
  const acc = await pool.query("SELECT * FROM padres_acceso WHERE cedula=$1", [ced]);
  if(!acc.rows.length) return res.status(404).json({ error: "Cuenta no encontrada" });
  const ok = await bcrypt.compare(password_actual || "", acc.rows[0].password_hash);
  if(!ok) return res.status(401).json({ error: "Contraseña actual incorrecta" });
  const hash = await bcrypt.hash(password_nuevo, 10);
  await pool.query("UPDATE padres_acceso SET password_hash=$1, primer_login=false WHERE cedula=$2", [hash, ced]);
  const padreSesion = { ...req.session.padre };
  await regenerateSession(req);
  req.session.padre = padreSesion;
  await saveSession(req);
  await pool.query("UPDATE padres_acceso SET sid_activo=$1 WHERE cedula=$2", [req.sessionID, ced]);
  res.json({ ok: true });
});

router.post("/logout", async (req, res) => {
  if(req.session && req.session.padre){
    await pool.query("UPDATE padres_acceso SET sid_activo=NULL WHERE cedula=$1 AND sid_activo=$2",
      [req.session.padre.cedula, req.sessionID]).catch(()=>{});
  }
  req.session.destroy(() => {
    res.clearCookie("lcf.sid");
    res.json({ ok: true });
  });
});

router.get("/me", async (req, res) => {
  const p = req.session && req.session.padre;
  if(!p) return res.json({ autenticado: false });
  // Verificar sesión única también aquí
  const r = await pool.query("SELECT sid_activo, primer_login, activo FROM padres_acceso WHERE cedula=$1", [p.cedula]);
  if(!r.rows.length || !r.rows[0].activo || r.rows[0].sid_activo !== req.sessionID){
    req.session.destroy(()=>{});
    return res.json({ autenticado: false });
  }
  const hijos = await hijosDe(p.cedula);
  res.json({ autenticado: true, padre: p, primer_login: r.rows[0].primer_login, hijos });
});

// ═══════════════════════════════════════════════════════════════════════════
//  DATOS DEL PORTAL (todo solo lectura y solo de SUS hijos)
// ═══════════════════════════════════════════════════════════════════════════

// ── Horario del hijo (grilla del año actual) ──────────────────────────────
router.get("/hijo/:id/horario", requirePadre, hijoDelPadre, async (req, res) => {
  const anio = anioCR();
  if(!req.hijo.seccion_id) return res.json({ lecciones: LECCIONES, celdas: [], seccion: null });
  const celdas = await pool.query(`
    SELECT h.dia, h.leccion, h.aula, m.nombre AS materia_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
    FROM horarios h
    LEFT JOIN asignaciones a ON a.id = h.asignacion_id
    LEFT JOIN materias m ON m.id = a.materia_id
    LEFT JOIN usuarios u ON u.id = a.profesor_id
    WHERE h.seccion_id = $1 AND h.anio = $2
    ORDER BY h.dia, h.leccion
  `, [req.hijo.seccion_id, anio]);
  res.json({ lecciones: LECCIONES, celdas: celdas.rows, seccion: req.hijo.seccion_nombre, anio });
});

// ── Entradas/salidas de portería ──────────────────────────────────────────
router.get("/hijo/:id/porteria", requirePadre, hijoDelPadre, async (req, res) => {
  const hasta = req.query.hasta || fechaCR();
  const desde = req.query.desde || `${anioCR()}-01-01`;
  const r = await pool.query(`
    SELECT fecha, hora, tipo, resultado, detalle
    FROM porteria_registros
    WHERE estudiante_id = $1 AND fecha BETWEEN $2 AND $3
    ORDER BY fecha DESC, hora DESC
    LIMIT 300
  `, [req.hijo.id, desde, hasta]);
  res.json(r.rows);
});

// ── Asistencia por día y materia ──────────────────────────────────────────
router.get("/hijo/:id/asistencia", requirePadre, hijoDelPadre, async (req, res) => {
  const hasta = req.query.hasta || fechaCR();
  const desde = req.query.desde || `${anioCR()}-01-01`;
  const r = await pool.query(`
    SELECT sa.fecha, sa.lecciones AS lecciones_sesion, m.nombre AS materia_nombre,
      a.estado, a.lecciones_ausentes, a.lecciones_tardias, a.justificada, a.motivo
    FROM asistencia a
    JOIN sesiones_asistencia sa ON sa.id = a.sesion_id
    JOIN asignaciones asg ON asg.id = sa.asignacion_id
    JOIN materias m ON m.id = asg.materia_id
    WHERE a.estudiante_id = $1 AND sa.fecha BETWEEN $2 AND $3
    ORDER BY sa.fecha DESC
    LIMIT 800
  `, [req.hijo.id, desde, hasta]);
  const rows = r.rows;
  const resumen = {
    ausencias: rows.filter(x=>x.estado==='A' && !x.justificada).length,
    ausencias_just: rows.filter(x=>x.estado==='A' && x.justificada).length,
    tardias: rows.filter(x=>x.estado==='T').length,
    presentes: rows.filter(x=>x.estado==='P').length,
  };
  res.json({ registros: rows, resumen });
});

// ── Conducta: boletas + nota por período ──────────────────────────────────
// USA EL MISMO CÁLCULO que el guía en /api/conducta/estudiante/:id?desde=X&hasta=Y
// para garantizar que la nota que ve el papá coincida con la que ve el guía.
router.get("/hijo/:id/conducta", requirePadre, hijoDelPadre, async (req, res) => {
  const anio = anioCR();
  const per = rangosPeriodo(anio);

  // Función interna que replica EXACTAMENTE el endpoint del guía
  async function traerBoletas(desde, hasta){
    const params = [req.hijo.id];
    let sql = `
      SELECT b.fecha, b.observacion, b.created_at,
        i.tipo, i.puntos, i.descripcion,
        m.nombre AS materia_nombre
      FROM boletas_conducta b
      JOIN infracciones i ON i.id = b.infraccion_id
      LEFT JOIN asignaciones a ON a.id = b.asignacion_id
      LEFT JOIN materias m ON m.id = a.materia_id
      WHERE b.estudiante_id = $1
    `;
    if(desde){ params.push(desde); sql += ` AND b.fecha >= $${params.length}`; }
    if(hasta){ params.push(hasta); sql += ` AND b.fecha <= $${params.length}`; }
    sql += " ORDER BY b.fecha DESC, b.created_at DESC";
    const r = await pool.query(sql, params);
    const totalRebajado = r.rows.reduce((s, b) => s + (b.puntos || 0), 0);
    const notaConducta = Math.max(0, 100 - totalRebajado);
    return { boletas: r.rows, totalRebajado, notaConducta };
  }

  const [dI, dII] = await Promise.all([
    traerBoletas(per.I.desde, per.I.hasta),
    traerBoletas(per.II.desde, per.II.hasta),
  ]);

  // Nota anual = promedio 50/50 (igual que hace el guía en modo anual)
  const notaAnual = Math.round((dI.notaConducta * 0.5) + (dII.notaConducta * 0.5));

  // Unificar todas las boletas de ambos períodos para la lista completa
  const todasBoletas = [...dI.boletas, ...dII.boletas].sort((a,b) =>
    String(b.fecha).localeCompare(String(a.fecha))
  );

  res.json({
    boletas: todasBoletas,
    boletas_I:  dI.boletas,
    boletas_II: dII.boletas,
    notaI:  dI.notaConducta,
    notaII: dII.notaConducta,
    notaAnual,
    totalRebajado_I:  dI.totalRebajado,
    totalRebajado_II: dII.totalRebajado,
  });
});

// ── Anuncios para el padre (todos o secciones de sus hijos) ───────────────
router.get("/anuncios", requirePadre, async (req, res) => {
  const hijos = await hijosDe(req.session.padre.cedula);
  const secIds = hijos.map(h=>h.seccion_id).filter(Boolean);
  const r = await pool.query(`
    SELECT a.id, a.titulo, a.cuerpo, a.para_todos, a.secciones, a.created_at
    FROM anuncios a
    WHERE a.activo = true
      AND (a.para_todos = true OR a.secciones && $1::int[])
    ORDER BY a.created_at DESC
    LIMIT 30
  `, [secIds.length ? secIds : [0]]);
  res.json(r.rows);
});

// ── Alertas: ausencias/tardías recientes + salidas denegadas (7 días) ─────
router.get("/alertas", requirePadre, async (req, res) => {
  const hijos = await hijosDe(req.session.padre.cedula);
  if(!hijos.length) return res.json([]);
  const ids = hijos.map(h=>h.id);
  const hoy = fechaCR();
  const desde = new Date(new Date(hoy+"T12:00:00Z").getTime() - 7*24*3600*1000).toISOString().slice(0,10);

  const aus = await pool.query(`
    SELECT a.estudiante_id, sa.fecha, m.nombre AS materia_nombre, a.estado, a.justificada
    FROM asistencia a
    JOIN sesiones_asistencia sa ON sa.id = a.sesion_id
    JOIN asignaciones asg ON asg.id = sa.asignacion_id
    JOIN materias m ON m.id = asg.materia_id
    WHERE a.estudiante_id = ANY($1::int[]) AND a.estado IN ('A','T')
      AND sa.fecha BETWEEN $2 AND $3
    ORDER BY sa.fecha DESC
  `, [ids, desde, hoy]);

  const den = await pool.query(`
    SELECT estudiante_id, fecha, hora, detalle
    FROM porteria_registros
    WHERE estudiante_id = ANY($1::int[]) AND tipo='salida' AND resultado='denegado'
      AND fecha BETWEEN $2 AND $3
    ORDER BY fecha DESC, hora DESC
  `, [ids, desde, hoy]);

  const nombreDe = {}; hijos.forEach(h => { nombreDe[h.id] = `${h.nombre} ${h.primer_apellido} ${h.segundo_apellido||''}`.replace(/\s+/g,' ').trim(); });
  const alertas = [];
  aus.rows.forEach(x => alertas.push({
    tipo: x.estado === 'A' ? 'ausencia' : 'tardia',
    hoy: String(x.fecha).slice(0,10) === hoy,
    fecha: String(x.fecha).slice(0,10),
    estudiante: nombreDe[x.estudiante_id],
    detalle: `${x.estado==='A'?'Ausencia':'Tardía'}${x.justificada?' (justificada)':''} en ${x.materia_nombre}`
  }));
  den.rows.forEach(x => alertas.push({
    tipo: 'salida_denegada',
    hoy: String(x.fecha).slice(0,10) === hoy,
    fecha: String(x.fecha).slice(0,10),
    estudiante: nombreDe[x.estudiante_id],
    detalle: `Intento de salida denegado a las ${x.hora}`
  }));
  alertas.sort((a,b) => b.fecha.localeCompare(a.fecha));
  res.json(alertas.slice(0, 40));
});

module.exports = router;

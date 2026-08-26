const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { obtenerLecciones } = require("./horarios");
const {
  fechaCR,
  obtenerAnioActivo,
  obtenerCalendario,
  obtenerPeriodoActual,
  obtenerRangoPeriodo,
} = require("../utils/lectivo");
const {
  createRateLimiter,
  regenerateSession,
  saveSession,
} = require("../middleware/security");
const { estadoConfiguracion } = require("../utils/push-familias");

const loginPadresLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiados intentos de ingreso. Espere 15 minutos e intente nuevamente.",
});

// ── Helpers Costa Rica ─────────────────────────────────────────────────────
function limpiarCedula(c){ return String(c||'').replace(/[\s\-.\/\\]/g,''); }
function horaCR(){
  return new Intl.DateTimeFormat("en-GB", {
    timeZone:"America/Costa_Rica", hour:"2-digit", minute:"2-digit", hour12:false,
  }).format(new Date());
}
function fechaValida(f){ return /^\d{4}-\d{2}-\d{2}$/.test(String(f||"")); }
function horaValida(h){ return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h||"").slice(0,5)); }
function minutos(h){ const [hh,mm]=String(h).slice(0,5).split(":").map(Number); return hh*60+mm; }
function horaDeMinutos(n){ return `${String(Math.floor(n/60)).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`; }

function validarMomento(fecha, hora){
  if(!fechaValida(fecha) || !horaValida(hora)) return "Fecha u hora inválida.";
  const hoy=fechaCR();
  if(fecha<hoy || (fecha===hoy && hora<=horaCR())) return "La cita debe ser en una fecha y hora futuras.";
  const limite=new Date(`${hoy}T12:00:00Z`); limite.setUTCDate(limite.getUTCDate()+180);
  if(fecha>limite.toISOString().slice(0,10)) return "La cita no puede programarse con más de 180 días de anticipación.";
  return null;
}

async function docenteDelHijo(hijo, profesorId, asignacionId=null){
  const anio=await obtenerAnioActivo();
  const periodo=(await obtenerPeriodoActual()).nombre;
  const params=[hijo.seccion_id, profesorId, anio, hijo.id, periodo];
  let extra="";
  if(asignacionId){ params.push(asignacionId); extra=` AND a.id=$${params.length}`; }
  const r=await pool.query(`
    SELECT a.id AS asignacion_id, a.profesor_id, a.subgrupo,
      m.nombre AS materia_nombre, u.nombre, u.primer_apellido, u.segundo_apellido
    FROM asignaciones a
    JOIN materias m ON m.id=a.materia_id
    JOIN usuarios u ON u.id=a.profesor_id
    JOIN estudiantes e ON e.id=$4
    WHERE a.seccion_id=$1 AND a.profesor_id=$2 AND COALESCE(a.anio,$3)=$3
      AND COALESCE(a.activa,true)=true
      AND COALESCE(a.periodo,'I Período') IN ('I Período',$5)
      AND (COALESCE(a.subgrupo,'')='' OR UPPER(a.subgrupo)=UPPER(COALESCE(e.subgrupo,'')))
      ${extra}
    ORDER BY CASE WHEN COALESCE(a.periodo,'I Período')=$5 THEN 0 ELSE 1 END, a.id DESC
    LIMIT 1
  `,params);
  return r.rows[0]||null;
}

async function validarSlotProfesor(profesorId, fecha, hora){
  const anio=await obtenerAnioActivo();
  const dia=new Date(`${fecha}T12:00:00Z`).getUTCDay();
  const r=await pool.query(`
    SELECT duracion_min, hora_inicio::text, hora_fin::text
    FROM citas_disponibilidad
    WHERE profesor_id=$1 AND anio=$2 AND dia_semana=$3 AND activa=true
  `,[profesorId,anio,dia]);
  const min=minutos(hora);
  return r.rows.find(b=>{
    const inicio=minutos(b.hora_inicio), fin=minutos(b.hora_fin), dur=Number(b.duracion_min);
    return min>=inicio && min+dur<=fin && (min-inicio)%dur===0;
  })||null;
}

async function hayChoqueCita(db, profesorId, estudianteId, fecha, hora, duracion, excluirId=null){
  const r=await db.query(`
    SELECT id FROM citas
    WHERE fecha=$3 AND estado IN ('pendiente','confirmada')
      AND (profesor_id=$1 OR estudiante_id=$2)
      AND ($6::int IS NULL OR id<>$6)
      AND hora < ($4::time + make_interval(mins=>$5::int))
      AND (hora + make_interval(mins=>duracion_min)) > $4::time
    LIMIT 1
  `,[profesorId,estudianteId,fecha,hora,duracion,excluirId]);
  return r.rows.length>0;
}

async function notificarDocente(profesorId,mensaje,citaId){
  await pool.query(
    "INSERT INTO notificaciones(usuario_id,tipo,mensaje,referencia_id) VALUES($1,'cita',$2,$3)",
    [profesorId,mensaje,citaId]
  ).catch(()=>{});
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
      AND COALESCE(enc.es_principal,false) = true
      AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
  `, [ced]);
  return r.rows;
}

// ── Middleware: sesión de padre válida + sesión única ─────────────────────
async function requirePadre(req, res, next){
  const p = req.session && req.session.padre;
  if(!p) return res.status(401).json({ error: "No autorizado" });
  if(p.modo_prueba){
    if(req.session?.usuario?.rol !== "admin" || req.session.usuario.id !== p.administrador_id)
      return res.status(401).json({ error: "Vista de prueba no autorizada" });
    if(req.method !== "GET")
      return res.status(403).json({ error: "La vista de prueba es de solo lectura. No se guardó ningún cambio." });
    return next();
  }
  try {
    const r = await pool.query("SELECT sid_activo, activo, servicio_habilitado FROM padres_acceso WHERE cedula=$1", [p.cedula]);
    if(!r.rows.length || !r.rows[0].activo || !r.rows[0].servicio_habilitado)
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
    return res.status(404).json({ error: "Esta cédula no está designada como encargado principal de ningún estudiante activo. Verificá la designación en la institución." });

  // El servicio familiar es de activación institucional. No se crea solo:
  // primero la institución confirma el pago y habilita la cuenta.
  const servicioR = await pool.query(
    "SELECT activo,servicio_habilitado FROM padres_acceso WHERE cedula=$1",
    [ced]
  );
  if(!servicioR.rows.length || !servicioR.rows[0].servicio_habilitado)
    return res.status(403).json({ error:"El servicio familiar todavía no ha sido habilitado por la institución." });
  if(!servicioR.rows[0].activo)
    return res.status(403).json({ error:"Acceso bloqueado. Contacte a la institución." });

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
      return res.status(403).json({ error:"El servicio familiar todavía no ha sido habilitado por la institución." });
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
  if(!password_nuevo || password_nuevo.length < 10)
    return res.status(400).json({ error: "La nueva contraseña debe tener al menos 10 caracteres" });
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
  if(req.session?.padre?.modo_prueba && req.session?.usuario?.rol === "admin"){
    delete req.session.padre;
    await saveSession(req);
    return res.json({ ok:true, modo_prueba:true });
  }
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
  if(p.modo_prueba){
    if(req.session?.usuario?.rol !== "admin" || req.session.usuario.id !== p.administrador_id){
      delete req.session.padre;
      await saveSession(req);
      return res.json({ autenticado:false });
    }
    const hijos = await hijosDe(p.cedula);
    const anio = await obtenerAnioActivo();
    const calendario = await obtenerCalendario(anio);
    return res.json({ autenticado:true, padre:p, primer_login:false, hijos, anio_activo:anio, calendario, solo_lectura:true });
  }
  // Verificar sesión única también aquí
  const r = await pool.query("SELECT sid_activo, primer_login, activo, servicio_habilitado FROM padres_acceso WHERE cedula=$1", [p.cedula]);
  if(!r.rows.length || !r.rows[0].activo || !r.rows[0].servicio_habilitado || r.rows[0].sid_activo !== req.sessionID){
    req.session.destroy(()=>{});
    return res.json({ autenticado: false });
  }
  const hijos = await hijosDe(p.cedula);
  const anio = await obtenerAnioActivo();
  const calendario = await obtenerCalendario(anio);
  res.json({ autenticado: true, padre: p, primer_login: r.rows[0].primer_login, hijos, anio_activo:anio, calendario });
});

router.get("/config", requirePadre, async (req,res)=>{
  const anio=await obtenerAnioActivo();
  res.json({ anio_activo:anio, calendario:await obtenerCalendario(anio) });
});

// ── Notificaciones en cada dispositivo de la familia ─────────────────────
router.get("/push/config", requirePadre, async (req,res)=>{
  res.json(estadoConfiguracion());
});

router.post("/push/suscribir", requirePadre, async (req,res)=>{
  const suscripcion=req.body?.subscription||{};
  const endpoint=String(suscripcion.endpoint||"").trim();
  const p256dh=String(suscripcion.keys?.p256dh||"").trim();
  const auth=String(suscripcion.keys?.auth||"").trim();
  let endpointUrl;
  try{ endpointUrl=new URL(endpoint); }catch{}
  if(!endpointUrl || endpointUrl.protocol!=="https:" || endpoint.length>4096 || !p256dh || !auth || p256dh.length>1000 || auth.length>1000)
    return res.status(400).json({error:"La suscripción de notificaciones no es válida."});
  if(!estadoConfiguracion().configurada)
    return res.status(503).json({error:"Las notificaciones todavía no están configuradas en el servidor."});

  const r=await pool.query(`
    INSERT INTO push_suscripciones(padre_acceso_id,endpoint,p256dh,auth,user_agent)
    SELECT id,$2,$3,$4,$5 FROM padres_acceso WHERE cedula=$1 AND activo=true
    ON CONFLICT(endpoint) DO UPDATE SET
      padre_acceso_id=EXCLUDED.padre_acceso_id,
      p256dh=EXCLUDED.p256dh,
      auth=EXCLUDED.auth,
      user_agent=EXCLUDED.user_agent,
      updated_at=NOW()
    RETURNING id
  `,[req.session.padre.cedula,endpoint,p256dh,auth,String(req.get("user-agent")||"").slice(0,500)]);
  if(!r.rows.length) return res.status(404).json({error:"No se encontró la cuenta familiar."});
  res.json({ok:true});
});

// ═══════════════════════════════════════════════════════════════════════════
//  DATOS DEL PORTAL (todo solo lectura y solo de SUS hijos)
// ═══════════════════════════════════════════════════════════════════════════

// ── Horario del hijo (grilla del año actual) ──────────────────────────────
router.get("/hijo/:id/horario", requirePadre, hijoDelPadre, async (req, res) => {
  const anio = await obtenerAnioActivo();
  const lecciones = obtenerLecciones(anio);
  if(!req.hijo.seccion_id) return res.json({ lecciones, celdas: [], seccion: null, anio });
  const celdas = await pool.query(`
    SELECT h.dia, h.leccion, h.aula, h.materia_texto, m.nombre AS materia_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2
    FROM horarios h
    LEFT JOIN asignaciones a ON a.id = h.asignacion_id
    LEFT JOIN materias m ON m.id = a.materia_id
    LEFT JOIN usuarios u ON u.id = a.profesor_id
    WHERE h.seccion_id = $1 AND h.anio = $2
    ORDER BY h.dia, h.leccion
  `, [req.hijo.seccion_id, anio]);
  res.json({ lecciones, celdas: celdas.rows, seccion: req.hijo.seccion_nombre, anio });
});

// ── Entradas/salidas de portería ──────────────────────────────────────────
router.get("/hijo/:id/porteria", requirePadre, hijoDelPadre, async (req, res) => {
  const hasta = req.query.hasta || fechaCR();
  const anio = await obtenerAnioActivo();
  const desde = req.query.desde || `${anio}-01-01`;
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
  const anio = await obtenerAnioActivo();
  const desde = req.query.desde || `${anio}-01-01`;
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

// ── Asistencia de un día según el horario ────────────────────────────────
// También devuelve clases aún sin registrar, para que el encargado vea la
// jornada completa y no solamente las ausencias ya guardadas.
router.get("/hijo/:id/asistencia-dia", requirePadre, hijoDelPadre, async (req,res)=>{
  const fecha=String(req.query.fecha||fechaCR()).slice(0,10);
  if(!fechaValida(fecha)) return res.status(400).json({error:"Fecha inválida."});
  const dia=new Date(`${fecha}T12:00:00Z`).getUTCDay();
  const anio=await obtenerAnioActivo();
  if(dia<1||dia>5||!req.hijo.seccion_id) return res.json({fecha,anio,clases:[]});
  const r=await pool.query(`
    SELECT h.leccion, h.aula, h.asignacion_id, h.materia_texto,
      m.nombre AS materia_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2,
      ast.estado, ast.justificada, ast.lecciones_ausentes, ast.lecciones_tardias,
      sa.id AS sesion_id
    FROM horarios h
    LEFT JOIN asignaciones a ON a.id=h.asignacion_id
    LEFT JOIN materias m ON m.id=a.materia_id
    LEFT JOIN usuarios u ON u.id=a.profesor_id
    LEFT JOIN sesiones_asistencia sa ON sa.asignacion_id=h.asignacion_id AND sa.fecha=$4
    LEFT JOIN asistencia ast ON ast.sesion_id=sa.id AND ast.estudiante_id=$3
    LEFT JOIN estudiantes e ON e.id=$3
    WHERE h.seccion_id=$1 AND h.anio=$2 AND h.dia=$5
      AND (h.asignacion_id IS NULL OR COALESCE(a.subgrupo,'')=''
        OR UPPER(a.subgrupo)=UPPER(COALESCE(e.subgrupo,'')))
    ORDER BY h.leccion, h.id
  `,[req.hijo.seccion_id,anio,req.hijo.id,fecha,dia]);
  const ahora=horaCR(), hoy=fechaCR();
  const clases=r.rows.map(x=>{
    const leccion=obtenerLecciones(anio).find(l=>l.n===Number(x.leccion));
    let situacion="sin_registrar";
    if(x.estado) situacion="registrada";
    else if(fecha>hoy || (fecha===hoy && leccion && ahora<leccion.ini)) situacion="proxima";
    else if(fecha===hoy && leccion && ahora>=leccion.ini && ahora<=leccion.fin) situacion="en_curso";
    return {...x,hora_inicio:leccion?.ini||null,hora_fin:leccion?.fin||null,situacion};
  });
  res.json({fecha,anio,clases});
});

// ── Permisos de salida del estudiante ────────────────────────────────────
router.get("/hijo/:id/permisos", requirePadre, hijoDelPadre, async (req,res)=>{
  const anio=await obtenerAnioActivo();
  const r=await pool.query(`
    SELECT p.id,p.numero,p.anio,p.tipo,p.fecha::text,p.hora_salida,p.motivo,
      p.autoriza_nombre,p.anulado,p.created_at,
      EXISTS(SELECT 1 FROM permisos_salida_usos u
        WHERE u.permiso_id=p.id AND u.estudiante_id=$1) AS utilizado
    FROM permisos_salida p
    WHERE p.anio=$2 AND (p.estudiante_id=$1 OR (p.tipo='seccion' AND p.seccion_id=$3))
    ORDER BY p.fecha DESC,p.numero DESC LIMIT 100
  `,[req.hijo.id,anio,req.hijo.seccion_id||0]);
  res.json(r.rows);
});

// ── Docentes que actualmente le dan clase al hijo ────────────────────────
router.get("/hijo/:id/docentes", requirePadre, hijoDelPadre, async (req,res)=>{
  const anio=await obtenerAnioActivo();
  const periodo=(await obtenerPeriodoActual()).nombre;
  const r=await pool.query(`
    SELECT DISTINCT ON(a.profesor_id,a.materia_id)
      a.profesor_id,a.id AS asignacion_id,m.nombre AS materia_nombre,
      u.nombre,u.primer_apellido,u.segundo_apellido
    FROM asignaciones a
    JOIN materias m ON m.id=a.materia_id
    JOIN usuarios u ON u.id=a.profesor_id
    JOIN estudiantes e ON e.id=$1
    WHERE a.seccion_id=$2 AND COALESCE(a.anio,$3)=$3 AND COALESCE(a.activa,true)=true
      AND COALESCE(a.periodo,'I Período') IN ('I Período',$4)
      AND (COALESCE(a.subgrupo,'')='' OR UPPER(a.subgrupo)=UPPER(COALESCE(e.subgrupo,'')))
      AND m.nombre NOT IN ('Guía','Orientación')
    ORDER BY a.profesor_id,a.materia_id,
      CASE WHEN COALESCE(a.periodo,'I Período')=$4 THEN 0 ELSE 1 END,a.id DESC
  `,[req.hijo.id,req.hijo.seccion_id||0,anio,periodo]);
  res.json(r.rows);
});

// Horas libres publicadas por un docente para los próximos 60 días.
router.get("/hijo/:id/citas/slots", requirePadre, hijoDelPadre, async (req,res)=>{
  const profesorId=Number(req.query.profesor_id);
  const asignacionId=Number(req.query.asignacion_id)||null;
  const docente=await docenteDelHijo(req.hijo,profesorId,asignacionId);
  if(!docente) return res.status(403).json({error:"Ese docente no imparte clases al estudiante."});
  const anio=await obtenerAnioActivo();
  const bloquesR=await pool.query(`SELECT dia_semana,hora_inicio::text,hora_fin::text,duracion_min
    FROM citas_disponibilidad WHERE profesor_id=$1 AND anio=$2 AND activa=true
    ORDER BY dia_semana,hora_inicio`,[profesorId,anio]);
  const hasta=new Date(`${fechaCR()}T12:00:00Z`); hasta.setUTCDate(hasta.getUTCDate()+60);
  const ocupadasR=await pool.query(`SELECT fecha::text,hora::text,duracion_min FROM citas
    WHERE profesor_id=$1 AND estado IN ('pendiente','confirmada')
      AND fecha BETWEEN $2 AND $3`,[profesorId,fechaCR(),hasta.toISOString().slice(0,10)]);
  const ocupadas=ocupadasR.rows.map(x=>({fecha:String(x.fecha).slice(0,10),inicio:minutos(x.hora),fin:minutos(x.hora)+Number(x.duracion_min)}));
  const slots=[];
  const d=new Date(`${fechaCR()}T12:00:00Z`);
  while(d<=hasta){
    const fecha=d.toISOString().slice(0,10), dia=d.getUTCDay();
    for(const b of bloquesR.rows.filter(x=>Number(x.dia_semana)===dia)){
      const ini=minutos(b.hora_inicio),fin=minutos(b.hora_fin),dur=Number(b.duracion_min);
      for(let m=ini;m+dur<=fin;m+=dur){
        const hora=horaDeMinutos(m);
        if(fecha===fechaCR()&&hora<=horaCR()) continue;
        const choca=ocupadas.some(o=>o.fecha===fecha&&m<o.fin&&m+dur>o.inicio);
        if(!choca) slots.push({fecha,hora,duracion_min:dur});
      }
    }
    d.setUTCDate(d.getUTCDate()+1);
  }
  res.json({profesor_id:profesorId,slots});
});

router.get("/hijo/:id/citas", requirePadre, hijoDelPadre, async (req,res)=>{
  const ced=limpiarCedula(req.session.padre.cedula);
  const anio=await obtenerAnioActivo();
  const r=await pool.query(`
    SELECT c.id,c.profesor_id,c.asignacion_id,c.fecha::text,c.hora::text,c.duracion_min,c.motivo,c.estado,
      c.pendiente_de,c.solicitada_por,c.es_contrapropuesta,c.respuesta_mensaje,c.created_at,
      u.nombre AS prof_nombre,u.primer_apellido AS prof_ap1,u.segundo_apellido AS prof_ap2,
      m.nombre AS materia_nombre
    FROM citas c
    JOIN usuarios u ON u.id=c.profesor_id
    LEFT JOIN asignaciones a ON a.id=c.asignacion_id
    LEFT JOIN materias m ON m.id=a.materia_id
    WHERE c.estudiante_id=$1 AND c.encargado_cedula=$2 AND c.anio=$3
    ORDER BY CASE WHEN c.estado='pendiente' THEN 0 WHEN c.estado='confirmada' THEN 1 ELSE 2 END,
      c.fecha,c.hora
  `,[req.hijo.id,ced,anio]);
  res.json(r.rows);
});

router.post("/hijo/:id/citas", requirePadre, hijoDelPadre, async (req,res)=>{
  const profesorId=Number(req.body.profesor_id), asignacionId=Number(req.body.asignacion_id)||null;
  const fecha=String(req.body.fecha||""),hora=String(req.body.hora||"").slice(0,5);
  const motivo=String(req.body.motivo||"").trim();
  const err=validarMomento(fecha,hora);
  if(err) return res.status(400).json({error:err});
  if(motivo.length<3) return res.status(400).json({error:"Indique brevemente el motivo de la cita."});
  const docente=await docenteDelHijo(req.hijo,profesorId,asignacionId);
  if(!docente) return res.status(403).json({error:"Ese docente no imparte clases al estudiante."});
  const bloque=await validarSlotProfesor(profesorId,fecha,hora);
  if(!bloque) return res.status(400).json({error:"La hora elegida ya no está disponible. Seleccione otra."});
  const anio=await obtenerAnioActivo(),ced=limpiarCedula(req.session.padre.cedula);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))',[profesorId,fecha]);
    await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))',[-req.hijo.id,fecha]);
    if(await hayChoqueCita(client,profesorId,req.hijo.id,fecha,hora,Number(bloque.duracion_min))){
      await client.query('ROLLBACK');
      return res.status(409).json({error:"Esa hora se cruza con otra cita. Seleccione una diferente."});
    }
    const r=await client.query(`INSERT INTO citas(anio,estudiante_id,profesor_id,asignacion_id,
      encargado_cedula,solicitada_por,fecha,hora,duracion_min,motivo,estado,pendiente_de)
      VALUES($1,$2,$3,$4,$5,'encargado',$6,$7,$8,$9,'pendiente','profesor') RETURNING id`,
      [anio,req.hijo.id,profesorId,docente.asignacion_id,ced,fecha,hora,Number(bloque.duracion_min),motivo]);
    await client.query('COMMIT');
    const nombre=`${req.hijo.nombre} ${req.hijo.primer_apellido} ${req.hijo.segundo_apellido||''}`.replace(/\s+/g,' ').trim();
    await notificarDocente(profesorId,`Nueva solicitud de cita para ${nombre}, el ${fecha} a las ${hora}.`,r.rows[0].id);
    res.json({ok:true,id:r.rows[0].id});
  }catch(e){
    await client.query('ROLLBACK').catch(()=>{});
    if(e.code==='23505') return res.status(409).json({error:"Esa hora acaba de ser reservada. Seleccione otra."});
    throw e;
  }finally{client.release();}
});

router.put("/citas/:id/responder", requirePadre, async (req,res)=>{
  const ced=limpiarCedula(req.session.padre.cedula),accion=String(req.body.accion||"");
  if(!['confirmar','rechazar','proponer'].includes(accion)) return res.status(400).json({error:"Respuesta inválida."});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query(`SELECT * FROM citas WHERE id=$1 AND encargado_cedula=$2 FOR UPDATE`,[req.params.id,ced]);
    if(!q.rows.length){await client.query('ROLLBACK');return res.status(404).json({error:"Cita no encontrada."});}
    const cita=q.rows[0];
    if(cita.estado!=='pendiente'||cita.pendiente_de!=='encargado'){
      await client.query('ROLLBACK');return res.status(400).json({error:"Esta cita ya no está pendiente de su respuesta."});
    }
    const mensaje=String(req.body.mensaje||"").trim();
    if(accion==='confirmar') await client.query(`UPDATE citas SET estado='confirmada',pendiente_de=NULL,respuesta_mensaje=$1,updated_at=NOW() WHERE id=$2`,[mensaje,cita.id]);
    else if(accion==='rechazar') await client.query(`UPDATE citas SET estado='rechazada',pendiente_de=NULL,respuesta_mensaje=$1,updated_at=NOW() WHERE id=$2`,[mensaje,cita.id]);
    else{
      const fecha=String(req.body.fecha||""),hora=String(req.body.hora||"").slice(0,5);
      const err=validarMomento(fecha,hora),bloque=err?null:await validarSlotProfesor(cita.profesor_id,fecha,hora);
      if(err||!bloque){await client.query('ROLLBACK');return res.status(400).json({error:err||"La hora seleccionada no está disponible."});}
      await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))',[cita.profesor_id,fecha]);
      await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))',[-cita.estudiante_id,fecha]);
      if(await hayChoqueCita(client,cita.profesor_id,cita.estudiante_id,fecha,hora,Number(bloque.duracion_min),cita.id)){
        await client.query('ROLLBACK');return res.status(409).json({error:"La hora se cruza con otra cita."});
      }
      await client.query(`UPDATE citas SET fecha=$1,hora=$2,duracion_min=$3,estado='pendiente',pendiente_de='profesor',
        es_contrapropuesta=true,respuesta_mensaje=$4,updated_at=NOW() WHERE id=$5`,[fecha,hora,Number(bloque.duracion_min),mensaje,cita.id]);
    }
    await client.query('COMMIT');
    await notificarDocente(cita.profesor_id,`El encargado respondió una solicitud de cita (${accion}).`,cita.id);
    res.json({ok:true});
  }catch(e){
    await client.query('ROLLBACK');
    if(e.code==='23505') return res.status(409).json({error:"Esa hora ya fue reservada."});
    throw e;
  }finally{client.release();}
});

router.put("/citas/:id/cancelar", requirePadre, async (req,res)=>{
  const ced=limpiarCedula(req.session.padre.cedula);
  const r=await pool.query(`UPDATE citas SET estado='cancelada',pendiente_de=NULL,
    respuesta_mensaje=$1,updated_at=NOW()
    WHERE id=$2 AND encargado_cedula=$3 AND estado IN ('pendiente','confirmada')
    RETURNING id,profesor_id`,[String(req.body.mensaje||"").trim(),req.params.id,ced]);
  if(!r.rows.length) return res.status(404).json({error:"La cita no existe o ya no puede cancelarse."});
  await notificarDocente(r.rows[0].profesor_id,"El encargado canceló una cita.",r.rows[0].id);
  res.json({ok:true});
});

// ── Conducta: boletas + nota por período ──────────────────────────────────
// USA EL MISMO CÁLCULO que el guía en /api/conducta/estudiante/:id?desde=X&hasta=Y
// para garantizar que la nota que ve el papá coincida con la que ve el guía.
router.get("/hijo/:id/conducta", requirePadre, hijoDelPadre, async (req, res) => {
  const anio = await obtenerAnioActivo();
  const [perI,perII] = await Promise.all([
    obtenerRangoPeriodo("I Período",pool,anio),
    obtenerRangoPeriodo("II Período",pool,anio),
  ]);
  const per = { I:perI, II:perII };

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

router.get('/calendario-pruebas',requirePadre,async(req,res)=>{
  const r=await pool.query(`SELECT c.id AS calendario_id,c.titulo,c.fecha_inicio::text,c.fecha_fin::text,e.fecha::text,e.hora_inicio::text,e.hora_fin::text,e.materia,e.seccion_id,s.nombre AS seccion_nombre,s.nivel,(SELECT COUNT(*)::int FROM secciones sx JOIN secciones_anio sa ON sa.seccion_id=sx.id AND sa.anio=EXTRACT(YEAR FROM e.fecha)::int AND sa.activa=true WHERE sx.nivel=s.nivel) AS secciones_nivel_total
    FROM calendarios_pruebas c JOIN calendario_pruebas_eventos e ON e.calendario_id=c.id JOIN secciones s ON s.id=e.seccion_id
    WHERE c.estado='publicado' AND c.fecha_fin>=CURRENT_DATE
    ORDER BY c.fecha_inicio,e.fecha,e.hora_inicio,s.nivel,s.nombre`);res.json(r.rows);
});

module.exports = router;

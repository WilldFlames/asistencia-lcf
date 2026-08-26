const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");
const { obtenerLecciones } = require("./horarios");
const { notificarEstudiante, notificarSecciones } = require("../utils/push-familias");

// ── Fecha/hora Costa Rica (mismo patrón que comedor.js) ────────────────────
function fechaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  return new Date(localMs).toISOString().slice(0,10);
}
function horaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  const local = new Date(localMs);
  const h = String(local.getUTCHours()).padStart(2,'0');
  const m = String(local.getUTCMinutes()).padStart(2,'0');
  return `${h}:${m}`;
}
function anioCR(){ return parseInt(fechaCR().slice(0,4)); }
// Día de semana de una fecha YYYY-MM-DD: 1=Lunes ... 5=Viernes (0/6 = finde)
function diaSemana(fecha){
  const d = new Date(fecha + "T12:00:00Z").getUTCDay(); // 0=Dom..6=Sáb
  return d; // el llamador interpreta 1..5
}
// Limpieza igual al carnet: quita espacios/guiones/puntos, preserva letras
function limpiarCedula(c){ return String(c||'').replace(/[\s\-.\/\\]/g,''); }

// ── Roles ──────────────────────────────────────────────────────────────────
const canEscanear = requireRol("admin","seguridad");
const canPermisos = requireRol("admin","auxiliar");
const canVer      = requireRol("admin","seguridad","auxiliar","administrativo");

// ═══════════════════════════════════════════════════════════════════════════
//  PERMISOS DE SALIDA
// ═══════════════════════════════════════════════════════════════════════════

// ── Buscar estudiante por cédula (para el formulario de permiso) ──────────
router.get("/estudiante/:cedula", requireRol("admin","auxiliar","seguridad"), async (req, res) => {
  const ced = limpiarCedula(req.params.cedula);
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.seccion_id, s.nombre AS seccion_nombre
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id = e.seccion_id
    WHERE REPLACE(REPLACE(REPLACE(e.cedula,'-',''),'.',''),' ','') = $1
      AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
  `, [ced]);
  if(!r.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
  res.json(r.rows[0]);
});

// ── Listar permisos (filtros: fecha o todos) ──────────────────────────────
router.get("/permisos", canVer, async (req, res) => {
  const { fecha, todos } = req.query;
  let where = "WHERE 1=1";
  const params = [];
  if(!todos){
    params.push(fecha || fechaCR());
    where += ` AND p.fecha = $${params.length}`;
  }
  const r = await pool.query(`
    SELECT p.*,
      e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
      e.cedula AS est_cedula,
      s.nombre AS seccion_nombre,
      u.nombre AS creador_nombre, u.primer_apellido AS creador_ap1, u.segundo_apellido AS creador_ap2,
      (SELECT COUNT(*) FROM permisos_salida_usos ps WHERE ps.permiso_id = p.id) AS usos
    FROM permisos_salida p
    LEFT JOIN estudiantes e ON e.id = p.estudiante_id
    LEFT JOIN secciones s ON s.id = p.seccion_id
    LEFT JOIN usuarios u ON u.id = p.creado_por
    ${where}
    ORDER BY p.fecha DESC, p.numero DESC
    LIMIT 300
  `, params);
  res.json(r.rows);
});

// ── Crear permiso (admin/auxiliar). Consecutivo interno por año ───────────
router.post("/permisos", canPermisos, async (req, res) => {
  const { tipo, estudiante_id, seccion_id, fecha, hora_salida,
          autoriza_nombre, autoriza_cedula, autoriza_parentesco, motivo, subgrupo } = req.body;

  if(!tipo || !["individual","seccion"].includes(tipo))
    return res.status(400).json({ error: "Tipo inválido (individual o seccion)" });
  if(tipo === "individual" && !estudiante_id)
    return res.status(400).json({ error: "Estudiante requerido para permiso individual" });
  if(tipo === "seccion" && !seccion_id)
    return res.status(400).json({ error: "Sección requerida para permiso por sección" });
  if(!fecha) return res.status(400).json({ error: "Fecha requerida" });
  if(!autoriza_nombre || !autoriza_nombre.trim())
    return res.status(400).json({ error: "Nombre de quien autoriza es requerido" });
  if(!motivo || !motivo.trim())
    return res.status(400).json({ error: "Motivo requerido" });

  const anio = parseInt(String(fecha).slice(0,4)) || anioCR();

  // INSERT atómico con el número calculado en la misma query (patrón consecutivos).
  // Si por carrera choca el UNIQUE(anio,numero), reintenta una vez.
  const insertar = () => pool.query(`
    INSERT INTO permisos_salida
      (numero, anio, tipo, estudiante_id, seccion_id, fecha, hora_salida,
       autoriza_nombre, autoriza_cedula, autoriza_parentesco, motivo, creado_por, subgrupo)
    VALUES (
      (SELECT COALESCE(MAX(numero),0)+1 FROM permisos_salida WHERE anio=$1),
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
    ) RETURNING *
  `, [anio, tipo,
      tipo === "individual" ? estudiante_id : null,
      tipo === "seccion" ? seccion_id : null,
      fecha, hora_salida || null,
      autoriza_nombre.trim(), (autoriza_cedula||'').trim() || null,
      (autoriza_parentesco||'').trim() || null, motivo.trim(),
      req.session.usuario.id, tipo === "seccion" && ["A","B"].includes(subgrupo) ? subgrupo : "todos"]);

  try {
    let r;
    try { r = await insertar(); }
    catch(e){
      if(String(e.message).includes("unique") || String(e.message).includes("duplicate")) r = await insertar();
      else throw e;
    }
    const permiso=r.rows[0];
    // Avisar a quienes imparten clase durante la hora del permiso.
    if(hora_salida){
      try{
        const dia=diaSemana(String(fecha).slice(0,10));
        const leccion=obtenerLecciones(anio).find(l=>hora_salida>=l.ini && hora_salida<l.fin)?.n;
        if(dia>=1&&dia<=5&&leccion){
          const estudiante=tipo==="individual" ? await pool.query("SELECT seccion_id,nombre,primer_apellido,segundo_apellido,subgrupo FROM estudiantes WHERE id=$1",[estudiante_id]) : null;
          const seccionReal=tipo==="individual"?estudiante?.rows[0]?.seccion_id:seccion_id;
          const alcance=tipo==="individual"?estudiante?.rows[0]?.subgrupo:(subgrupo==="todos"?'':subgrupo);
          const profesores=await pool.query(`SELECT DISTINCT a.profesor_id FROM horarios h JOIN asignaciones a ON a.id=h.asignacion_id WHERE h.anio=$1 AND h.dia=$2 AND h.leccion=$3 AND h.seccion_id=$4 AND a.activa IS NOT FALSE AND ($5='' OR COALESCE(a.subgrupo,'')='' OR COALESCE(a.subgrupo,'')=$5)`,[anio,dia,leccion,seccionReal,alcance||'']);
          const sujeto=tipo==="individual"?`${estudiante.rows[0].nombre} ${estudiante.rows[0].primer_apellido}`:`la sección (alcance ${subgrupo||'todos'})`;
          for(const p of profesores.rows) await pool.query("INSERT INTO notificaciones(usuario_id,tipo,mensaje) VALUES($1,'permiso_salida',$2)",[p.profesor_id,`🚪 ${sujeto} tiene permiso de salida a las ${hora_salida}. Motivo: ${motivo.trim()}`]);
        }
      }catch(e){ console.error("Aviso de permiso a docentes:",e.message); }
    }
    const [y,m,d]=String(permiso.fecha||fecha).slice(0,10).split("-");
    const fechaTexto=d&&m&&y?`${d}/${m}/${y}`:String(fecha);
    const aviso={
      title:"Permiso de salida registrado",
      body:`Se registró un permiso de salida${hora_salida?` a las ${hora_salida}`:""} para el ${fechaTexto}. Ingrese al portal para revisarlo.`,
      url:"/?app=familias&abrir=permisos",
      tag:`permiso-salida-${permiso.id}`,
    };
    if(tipo==="individual") await notificarEstudiante(estudiante_id,{...aviso,body:`Se registró un permiso de salida para {estudiante}${hora_salida?` a las ${hora_salida}`:""}, correspondiente al ${fechaTexto}. Ingrese al portal para revisarlo.`});
    else await notificarSecciones([seccion_id],aviso);
    res.json({ ok: true, permiso });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Anular permiso ────────────────────────────────────────────────────────
router.put("/permisos/:id/anular", canPermisos, async (req, res) => {
  const r = await pool.query("UPDATE permisos_salida SET anulado=true WHERE id=$1 RETURNING id,tipo,estudiante_id,seccion_id", [req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error: "Permiso no encontrado" });
  const permiso=r.rows[0];
  const aviso={title:"Permiso de salida anulado",body:"La institución anuló un permiso de salida registrado anteriormente. Ingrese al portal para revisar el estado.",url:"/?app=familias&abrir=permisos",tag:`permiso-anulado-${permiso.id}`};
  if(permiso.tipo==="individual") await notificarEstudiante(permiso.estudiante_id,aviso);
  else await notificarSecciones([permiso.seccion_id],aviso);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ESCANEO EN PORTERÍA (rol seguridad / admin)
// ═══════════════════════════════════════════════════════════════════════════

// Calcula la hora en que terminan las lecciones del estudiante HOY.
// Devuelve { horaFin, tieneHorario }. Sin horario configurado → tieneHorario=false.
async function finLeccionesHoy(seccionId, fecha){
  const dia = diaSemana(fecha);
  if(dia < 1 || dia > 5) return { horaFin: null, tieneHorario: false, finde: true };
  const anio = parseInt(fecha.slice(0,4));
  const r = await pool.query(
    "SELECT MAX(leccion) AS ultima FROM horarios WHERE seccion_id=$1 AND anio=$2 AND dia=$3",
    [seccionId, anio, dia]
  );
  const ultima = r.rows[0] && r.rows[0].ultima;
  if(!ultima) return { horaFin: null, tieneHorario: false, finde: false };
  const lec = obtenerLecciones(anio).find(l => l.n === parseInt(ultima));
  return { horaFin: lec ? lec.fin : null, tieneHorario: true, finde: false, ultimaLeccion: parseInt(ultima) };
}

// ── ESCANEO ───────────────────────────────────────────────────────────────
// body: { cedula }. El servidor infiere entrada/salida para evitar errores del guarda.
// Se conserva tipo explícito por compatibilidad con clientes antiguos.
router.post("/escaneo", canEscanear, async (req, res) => {
  const { cedula } = req.body;
  let { tipo } = req.body;
  if(!cedula) return res.status(400).json({ error: "Cédula requerida" });
  if(tipo && !["entrada","salida","auto"].includes(tipo)) return res.status(400).json({ error: "Tipo inválido" });

  const fecha = fechaCR();
  const hora = horaCR();
  const ced = limpiarCedula(cedula);

  const estR = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id = e.seccion_id
    WHERE REPLACE(REPLACE(REPLACE(e.cedula,'-',''),'.',''),' ','') = $1
      AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
  `, [ced]);
  if(!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado en el sistema" });
  const est = estR.rows[0];
  const uid = req.session.usuario.id;

  if(!tipo || tipo === "auto"){
    const ultimo = await pool.query(`
      SELECT tipo FROM porteria_registros
      WHERE estudiante_id=$1 AND fecha=$2 AND resultado='permitido'
      ORDER BY hora DESC, id DESC LIMIT 1
    `, [est.id, fecha]);
    tipo = ultimo.rows[0]?.tipo === "entrada" ? "salida" : "entrada";
  }

  // ── ENTRADA: siempre se registra ─────────────────────────────────────
  if(tipo === "entrada"){
    await pool.query(`
      INSERT INTO porteria_registros (estudiante_id, fecha, hora, tipo, resultado, detalle, registrado_por)
      VALUES ($1,$2,$3,'entrada','permitido','Ingreso registrado',$4)
    `, [est.id, fecha, hora, uid]);
    return res.json({ ok: true, resultado: "permitido", tipo: "entrada", hora, estudiante: est, detalle: "Ingreso registrado" });
  }

  // ── SALIDA: lógica de horario + permisos ─────────────────────────────
  // 1. ¿Ya terminaron sus lecciones de hoy?
  const fin = await finLeccionesHoy(est.seccion_id, fecha);

  if(fin.finde){
    await pool.query(`
      INSERT INTO porteria_registros (estudiante_id, fecha, hora, tipo, resultado, detalle, registrado_por)
      VALUES ($1,$2,$3,'salida','permitido','Día no lectivo (fin de semana)',$4)
    `, [est.id, fecha, hora, uid]);
    return res.json({ ok: true, resultado: "permitido", tipo: "salida", hora, estudiante: est, detalle: "Día no lectivo (fin de semana)" });
  }

  if(!fin.tieneHorario){
    // Sin horario configurado para esta sección: el sistema NO puede bloquear.
    // Se permite con aviso, para no dejar estudiantes atrapados en el rollout.
    await pool.query(`
      INSERT INTO porteria_registros (estudiante_id, fecha, hora, tipo, resultado, detalle, registrado_por)
      VALUES ($1,$2,$3,'salida','permitido','⚠️ Sin horario configurado para su sección',$4)
    `, [est.id, fecha, hora, uid]);
    return res.json({ ok: true, resultado: "permitido", tipo: "salida", hora, estudiante: est,
      aviso: true, detalle: "⚠️ Sin horario configurado para su sección — configurar en módulo Horario" });
  }

  if(hora >= fin.horaFin){
    await pool.query(`
      INSERT INTO porteria_registros (estudiante_id, fecha, hora, tipo, resultado, detalle, registrado_por)
      VALUES ($1,$2,$3,'salida','permitido',$4,$5)
    `, [est.id, fecha, hora, `Fin de lecciones (terminó a las ${fin.horaFin})`, uid]);
    return res.json({ ok: true, resultado: "permitido", tipo: "salida", hora, estudiante: est,
      detalle: `Fin de lecciones (terminó a las ${fin.horaFin})` });
  }

  // 2. Todavía en horario lectivo → buscar permiso vigente sin usar por este estudiante
  const permR = await pool.query(`
    SELECT p.* FROM permisos_salida p
    WHERE p.anulado = false AND p.fecha = $1
      AND (
        (p.tipo = 'individual' AND p.estudiante_id = $2)
        OR (p.tipo = 'seccion' AND p.seccion_id = $3 AND (COALESCE(p.subgrupo,'todos')='todos' OR p.subgrupo=COALESCE($4,'todos')))
      )
      AND NOT EXISTS (
        SELECT 1 FROM permisos_salida_usos u
        WHERE u.permiso_id = p.id AND u.estudiante_id = $2
      )
    ORDER BY CASE WHEN p.tipo = 'individual' THEN 0 ELSE 1 END
    LIMIT 1
  `, [fecha, est.id, est.seccion_id, est.subgrupo]);

  if(permR.rows.length){
    const p = permR.rows[0];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO permisos_salida_usos (permiso_id, estudiante_id, fecha, hora, registrado_por)
        VALUES ($1,$2,$3,$4,$5)
      `, [p.id, est.id, fecha, hora, uid]);
      await client.query(`
        INSERT INTO porteria_registros (estudiante_id, fecha, hora, tipo, resultado, detalle, permiso_id, registrado_por)
        VALUES ($1,$2,$3,'salida','permitido',$4,$5,$6)
      `, [est.id, fecha, hora, `Permiso Nº ${p.numero}-${p.anio} · ${p.motivo}`, p.id, uid]);
      await client.query("COMMIT");
    } catch(e) {
      await client.query("ROLLBACK");
      client.release();
      return res.status(500).json({ error: e.message });
    }
    client.release();
    return res.json({ ok: true, resultado: "permitido", tipo: "salida", hora, estudiante: est,
      permiso: { numero: p.numero, anio: p.anio, motivo: p.motivo, autoriza: p.autoriza_nombre, tipo: p.tipo },
      detalle: `Permiso Nº ${p.numero}-${p.anio} · Autoriza: ${p.autoriza_nombre} · ${p.motivo}` });
  }

  // 3. Sin permiso → DENEGADO
  await pool.query(`
    INSERT INTO porteria_registros (estudiante_id, fecha, hora, tipo, resultado, detalle, registrado_por)
    VALUES ($1,$2,$3,'salida','denegado',$4,$5)
  `, [est.id, fecha, hora, `En horario lectivo (sus lecciones terminan a las ${fin.horaFin}) y sin permiso de salida`, uid]);
  return res.json({ ok: true, resultado: "denegado", tipo: "salida", hora, estudiante: est,
    detalle: `En horario lectivo — sus lecciones terminan a las ${fin.horaFin}. Sin permiso de salida registrado.` });
});

// ── REGISTROS DEL DÍA (historial) ─────────────────────────────────────────
router.get("/registros", canVer, async (req, res) => {
  const fecha = req.query.fecha || fechaCR();
  const r = await pool.query(`
    SELECT r.*, e.nombre, e.primer_apellido, e.segundo_apellido, e.cedula,
      s.nombre AS seccion_nombre,
      p.numero AS permiso_numero, p.anio AS permiso_anio
    FROM porteria_registros r
    JOIN estudiantes e ON e.id = r.estudiante_id
    LEFT JOIN secciones s ON s.id = e.seccion_id
    LEFT JOIN permisos_salida p ON p.id = r.permiso_id
    WHERE r.fecha = $1
    ORDER BY r.hora DESC, r.id DESC
  `, [fecha]);
  res.json(r.rows);
});

// ── STATS DEL DÍA ─────────────────────────────────────────────────────────
router.get("/stats", canVer, async (req, res) => {
  const fecha = req.query.fecha || fechaCR();
  const r = await pool.query(`
    SELECT
      COUNT(CASE WHEN tipo='entrada' THEN 1 END) AS entradas,
      COUNT(CASE WHEN tipo='salida' AND resultado='permitido' THEN 1 END) AS salidas,
      COUNT(CASE WHEN tipo='salida' AND resultado='denegado' THEN 1 END) AS denegadas
    FROM porteria_registros WHERE fecha=$1
  `, [fecha]);
  res.json(r.rows[0] || { entradas: 0, salidas: 0, denegadas: 0 });
});

module.exports = router;

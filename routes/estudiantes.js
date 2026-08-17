const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");
const cldHelper = require("./cloudinary-helper");
const { notificarEstudiante } = require("../utils/push-familias");
const { seccionesPermitidas, puedeAccederEstudiante, exigirAccesoEstudiante } = require("../utils/acceso-estudiantes");

const canManage = requireRol("admin","auxiliar");

async function validarRestriccionSeccionActual(estudianteId, seccionId, db = pool){
  if(!estudianteId || !seccionId) return null;
  const r = await db.query(`
    WITH restringidos AS (
      SELECT CASE WHEN estudiante_a_id=$1 THEN estudiante_b_id ELSE estudiante_a_id END AS otro_id,
             motivo
      FROM restricciones_matricula
      WHERE activa=true
        AND anio=COALESCE((SELECT anio FROM anios_lectivos WHERE estado='activo' LIMIT 1), EXTRACT(YEAR FROM CURRENT_DATE)::int)
        AND (estudiante_a_id=$1 OR estudiante_b_id=$1)
    )
    SELECT e.nombre,e.primer_apellido,e.segundo_apellido,s.nombre AS seccion_nombre,r.motivo
    FROM restringidos r JOIN estudiantes e ON e.id=r.otro_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.activo=true AND COALESCE(e.archivado,false)=false AND e.seccion_id=$2
    LIMIT 1
  `, [estudianteId,seccionId]);
  return r.rows[0] || null;
}

function mensajeRestriccionSeccion(conflicto){
  const nombre=`${conflicto.nombre||''} ${conflicto.primer_apellido||''} ${conflicto.segundo_apellido||''}`.replace(/\s+/g,' ').trim();
  return `No se puede asignar esta sección: existe una restricción de convivencia con ${nombre}, que ya está en ${conflicto.seccion_nombre}. Motivo: ${conflicto.motivo}. Seleccione otra sección.`;
}

// Helper: registra un evento en el historial del estudiante.
// Es "fire-and-forget" — no bloquea la respuesta si falla, solo loggea.
// Acepta cliente opcional para usar dentro de transacciones.
async function logHistorial(estudianteId, tipo, valorAnterior, valorNuevo, justificacion, usuarioId, client) {
  if (!estudianteId || !tipo) return;
  const conn = client || pool;
  try {
    await conn.query(
      `INSERT INTO historial_estudiante (estudiante_id, tipo, valor_anterior, valor_nuevo, justificacion, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [estudianteId, tipo, valorAnterior || null, valorNuevo || null, justificacion || null, usuarioId || null]
    );
  } catch (e) {
    console.error(`[HIST] Error registrando ${tipo} para est ${estudianteId}:`, e.message);
  }
}

// Devuelve únicamente al personal docente que realmente atiende al estudiante.
// Una asignación sin subgrupo atiende a toda la sección; una asignación A/B
// solo recibe movimientos del mismo subgrupo. Si el estudiante aún no tiene
// subgrupo, se avisa a toda la sección para no ocultar un ingreso pendiente de
// clasificación. El profesor guía siempre recibe los movimientos de su grupo.
async function profesoresParaMovimientoEstudiante(seccionId, subgrupo, db = pool) {
  if (!seccionId) return [];
  const r = await db.query(`
    SELECT DISTINCT destinatario_id AS uid
    FROM (
      SELECT a.profesor_id AS destinatario_id
      FROM asignaciones a
      WHERE a.seccion_id=$1
        AND a.profesor_id IS NOT NULL
        AND a.anio=COALESCE(
          (SELECT anio FROM anios_lectivos WHERE estado='activo' LIMIT 1),
          EXTRACT(YEAR FROM (NOW() AT TIME ZONE 'America/Costa_Rica'))::int
        )
        AND (
          COALESCE(a.subgrupo,'')=''
          OR COALESCE($2::text,'')=''
          OR UPPER(a.subgrupo)=UPPER($2::text)
        )
      UNION
      SELECT sg.profesor_id AS destinatario_id
      FROM seccion_guia sg
      WHERE sg.seccion_id=$1 AND sg.profesor_id IS NOT NULL
    ) destinatarios
    WHERE destinatario_id IS NOT NULL
  `, [seccionId, subgrupo || ""]);
  return r.rows;
}

async function notificarMovimientoEstudiante(seccionId, subgrupo, mensaje, tipo, excluirUsuarioId = null, db = pool) {
  const profesores = await profesoresParaMovimientoEstudiante(seccionId, subgrupo, db);
  for (const profesor of profesores) {
    if (excluirUsuarioId && Number(profesor.uid) === Number(excluirUsuarioId)) continue;
    try {
      await db.query(
        "INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1,$2,$3)",
        [profesor.uid, tipo, mensaje]
      );
    } catch (e) {
      // La notificación no debe impedir el movimiento principal del estudiante.
      console.error("Error notificando movimiento de estudiante", profesor.uid, e.message);
    }
  }
}

// Caché de columnas de la tabla estudiantes (excluyendo foto_url).
// Se llena en la primera consulta para no depender de saber qué columnas
// existen en cada instalación (algunas instalaciones tienen
// justificacion_baja, otras no, etc.)
let _columnasEstudiantes = null;
async function getColumnasEstudiantesSinFoto() {
  if (_columnasEstudiantes) return _columnasEstudiantes;
  const r = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'estudiantes' AND column_name <> 'foto_url'
    ORDER BY ordinal_position
  `);
  _columnasEstudiantes = r.rows.map(x => `e.${x.column_name}`).join(", ");
  return _columnasEstudiantes;
}

// ── LISTAR ────────────────────────────────────────────────────
// IMPORTANTE: NO traer foto_url. La foto se guarda como base64 en una
// columna TEXT y puede pesar cientos de KB. Multiplicado por 800 estudiantes
// es ~100+ MB de payload innecesario en cada llamada. La foto se consulta
// puntualmente cuando se abre un expediente o el carnet.
router.get("/", requireAuth, async (req, res) => {
  const { seccion_id, q } = req.query;
  try {
    const cols = await getColumnasEstudiantesSinFoto();
    // OCTET_LENGTH(foto_url) > 0 es rapidísimo: PostgreSQL no necesita
    // cargar el contenido completo del TEXT para saber su longitud.
    let sql = `SELECT ${cols}, s.nombre AS seccion_nombre,
        COALESCE(OCTET_LENGTH(e.foto_url) > 0, false) AS tiene_foto
      FROM estudiantes e
      LEFT JOIN secciones s ON s.id=e.seccion_id
      WHERE e.activo=true AND (e.archivado=false OR e.archivado IS NULL)`;
    const params = [];
    const permitidas=await seccionesPermitidas(req.session.usuario);
    if(permitidas!==null){ params.push(permitidas); sql += ` AND e.seccion_id=ANY($${params.length}::int[])`; }
    if (seccion_id) { params.push(seccion_id); sql += ` AND e.seccion_id=$${params.length}`; }
    if (q) { params.push(`%${q}%`); sql += ` AND (e.cedula ILIKE $${params.length} OR e.primer_apellido ILIKE $${params.length} OR e.segundo_apellido ILIKE $${params.length} OR e.nombre ILIKE $${params.length})`; }
    sql += " ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre";
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    console.error("GET /estudiantes:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── FOTOS BATCH (varias fotos por IDs) ─────────────────────
// Devuelve un mapa id->foto_url para los IDs pasados como query string.
// Ej: GET /api/estudiantes/fotos?ids=1,5,12,33
// Útil para pantallas que muestran miniatura de varios estudiantes a la vez
// (ej. carnet), pero sin pagar el costo de traer todas las fotos del listado.
router.get("/fotos", requireAuth, async (req, res) => {
  const idsStr = String(req.query.ids || "");
  if (!idsStr) return res.json({});
  const ids = idsStr.split(",")
    .map(s => parseInt(s, 10))
    .filter(n => Number.isInteger(n) && n > 0)
    .slice(0, 100); // cap razonable para evitar payloads gigantes
  if (!ids.length) return res.json({});
  const permitidas=await seccionesPermitidas(req.session.usuario);
  if(permitidas!==null && !permitidas.length) return res.json({});
  const r = await pool.query(
    `SELECT id, foto_url FROM estudiantes WHERE id = ANY($1::int[])
      AND ($2::int[] IS NULL OR seccion_id=ANY($2::int[]))`,
    [ids,permitidas]
  );
  const out = {};
  for (const row of r.rows) out[row.id] = row.foto_url || null;
  res.json(out);
});

// ── FOTO INDIVIDUAL ─────────────────────────────────────────
// Devuelve solo la foto_url base64 de un estudiante. Se llama bajo demanda
// cuando se necesita mostrar (expediente, carnet, etc.).
router.get("/:id/foto", requireAuth, exigirAccesoEstudiante(req=>req.params.id), async (req, res) => {
  const r = await pool.query("SELECT foto_url FROM estudiantes WHERE id=$1", [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "No encontrado" });
  res.json({ foto_url: r.rows[0].foto_url || null });
});

// ── CONSULTA POR CÉDULA (todos los docentes) ─────────────────
router.get("/consulta/:cedula", requireAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.cedula=$1 AND e.activo=true
  `, [req.params.cedula.trim()]);
  if (!r.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
  const est = r.rows[0];
  if(!await puedeAccederEstudiante(req.session.usuario,est.id)) return res.status(403).json({error:"No tiene permiso para consultar este estudiante."});
  const enc = await pool.query("SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC", [est.id]);
  res.json({ ...est, encargados: enc.rows });
});

// ── HISTORIAL del estudiante ──────────────────────────────────
// Devuelve los movimientos registrados ordenados del más reciente al más antiguo.
router.get("/:id/historial", requireAuth, exigirAccesoEstudiante(req=>req.params.id), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT h.id, h.tipo, h.valor_anterior, h.valor_nuevo, h.justificacion, h.fecha,
             u.primer_apellido AS u_ap1, u.segundo_apellido AS u_ap2,
             u.nombre AS u_nombre, u.rol AS u_rol
      FROM historial_estudiante h
      LEFT JOIN usuarios u ON u.id = h.usuario_id
      WHERE h.estudiante_id = $1
      ORDER BY h.fecha DESC, h.id DESC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) {
    console.error("GET historial:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── CREAR ─────────────────────────────────────────────────────
router.post("/", canManage, async (req, res) => {
  const { cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento, seccion_id, subgrupo, becado } = req.body;
  if (!cedula||!nombre||!primer_apellido||!segundo_apellido)
    return res.status(400).json({ error: "Datos incompletos" });

  // Helper: obtiene el nombre de una sección (o "Sin sección" si no hay)
  async function nombreSeccion(seccionId) {
    if (!seccionId) return "Sin sección";
    const r = await pool.query("SELECT nombre FROM secciones WHERE id=$1", [seccionId]);
    return r.rows[0]?.nombre || "Sin sección";
  }

  try {
    // Verificar si ya existe (activo o inactivo)
    const existe = await pool.query("SELECT id, activo, seccion_id FROM estudiantes WHERE cedula=$1", [cedula.trim()]);

    if(existe.rows.length > 0) {
      const est = existe.rows[0];
      if(est.activo) {
        return res.status(409).json({ error: "Ya existe un estudiante activo con esa cédula" });
      }
      // Estaba eliminado — reactivar con los nuevos datos
      const conflicto = await validarRestriccionSeccionActual(est.id,seccion_id);
      if(conflicto) return res.status(409).json({ error:mensajeRestriccionSeccion(conflicto),restriccion:true });
      await pool.query(`
        UPDATE estudiantes SET
          nombre=$1, primer_apellido=$2, segundo_apellido=$3,
          fecha_nacimiento=$4, seccion_id=$5, subgrupo=$6, becado=$7,
          activo=true
        WHERE id=$8
      `, [nombre.trim(), primer_apellido.trim(), segundo_apellido.trim(),
          fecha_nacimiento||null, seccion_id||null, subgrupo||null,
          becado||false, est.id]);

      // Notificar reactivación a la sección nueva
      if (seccion_id) {
        const secNombre = await nombreSeccion(seccion_id);
        const msg = `🔄 Reingreso: ${nombre.trim()} ${primer_apellido.trim()} ${segundo_apellido.trim()} (${cedula.trim()}) fue reactivado(a) en la sección ${secNombre}.`;
        await notificarMovimientoEstudiante(seccion_id, subgrupo, msg, 'reingreso_estudiante');
      }
      // Historial: reactivación
      await logHistorial(est.id, 'reactivacion',
        'Estudiante inactivo',
        seccion_id ? `Reactivado en ${await nombreSeccion(seccion_id)}` : 'Reactivado sin sección',
        null, req.session.usuario?.id);
      return res.json({ ok:true, id: est.id, reactivado: true });
    }

    // No existe — crear nuevo
    const r = await pool.query(`
      INSERT INTO estudiantes (cedula,nombre,primer_apellido,segundo_apellido,fecha_nacimiento,seccion_id,subgrupo,becado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [cedula.trim(), nombre.trim(), primer_apellido.trim(), segundo_apellido.trim(),
        fecha_nacimiento||null, seccion_id||null, subgrupo||null, becado||false]);

    const nuevoId = r.rows[0].id;
    // Historial: creación
    await logHistorial(nuevoId, 'creacion',
      null,
      `${nombre.trim()} ${primer_apellido.trim()} ${segundo_apellido.trim()}` +
        (seccion_id ? ` en sección ${await nombreSeccion(seccion_id)}` : ''),
      null, req.session.usuario?.id);

    // Notificar nuevo ingreso a profesores y guía de la sección
    if (seccion_id) {
      const secNombre = await nombreSeccion(seccion_id);
      const subTxt = subgrupo ? ` · Subgrupo ${subgrupo}` : "";
      const msg = `🆕 Nuevo ingreso: ${nombre.trim()} ${primer_apellido.trim()} ${segundo_apellido.trim()} (${cedula.trim()}) fue matriculado(a) en la sección ${secNombre}${subTxt}.`;
      await notificarMovimientoEstudiante(seccion_id, subgrupo, msg, 'nuevo_estudiante');
    }

    res.json({ ok:true, id: nuevoId });
  } catch(e) {
    console.error("POST estudiantes:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── EDITAR (solo auxiliar/admin) ─────────────────────────────
router.put("/:id", canManage, async (req, res) => {
  const { nombre, primer_apellido, segundo_apellido, fecha_nacimiento, subgrupo, becado } = req.body;
  const becadoVal = becado !== undefined ? !!becado : null;

  // Leer valores anteriores para comparar y registrar solo cambios reales
  const antes = await pool.query(
    "SELECT nombre, primer_apellido, segundo_apellido, fecha_nacimiento, subgrupo, becado FROM estudiantes WHERE id=$1",
    [req.params.id]
  );
  const old = antes.rows[0] || {};

  if(becadoVal !== null){
    await pool.query(`UPDATE estudiantes SET nombre=$1,primer_apellido=$2,segundo_apellido=$3,fecha_nacimiento=$4,subgrupo=$5,becado=$6 WHERE id=$7`,
      [nombre.trim(),primer_apellido.trim(),segundo_apellido.trim(),fecha_nacimiento||null,subgrupo||null,becadoVal,req.params.id]);
  } else {
    await pool.query(`UPDATE estudiantes SET nombre=$1,primer_apellido=$2,segundo_apellido=$3,fecha_nacimiento=$4,subgrupo=$5 WHERE id=$6`,
      [nombre.trim(),primer_apellido.trim(),segundo_apellido.trim(),fecha_nacimiento||null,subgrupo||null,req.params.id]);
  }

  // Registrar cambios en historial. Para no llenar el historial de basura,
  // solo registramos campos que efectivamente cambiaron.
  const uid = req.session.usuario?.id;
  const fmtFecha = (f) => {
    if (!f) return '';
    const d = new Date(f);
    if (isNaN(d.getTime())) return String(f);
    return String(d.getUTCDate()).padStart(2,'0') + '/' +
           String(d.getUTCMonth()+1).padStart(2,'0') + '/' + d.getUTCFullYear();
  };
  const nombreNuevo = `${nombre.trim()} ${primer_apellido.trim()} ${segundo_apellido.trim()}`;
  const nombreViejo = `${old.nombre||''} ${old.primer_apellido||''} ${old.segundo_apellido||''}`.replace(/\s+/g,' ').trim();
  if (nombreViejo !== nombreNuevo) {
    await logHistorial(req.params.id, 'edicion_nombre', nombreViejo, nombreNuevo, null, uid);
  }
  const fechaViejaTxt = fmtFecha(old.fecha_nacimiento);
  const fechaNuevaTxt = fmtFecha(fecha_nacimiento);
  if (fechaViejaTxt !== fechaNuevaTxt) {
    await logHistorial(req.params.id, 'edicion_fecha_nac', fechaViejaTxt || '(sin fecha)', fechaNuevaTxt || '(sin fecha)', null, uid);
  }
  if ((old.subgrupo||'') !== (subgrupo||'')) {
    await logHistorial(req.params.id, 'cambio_subgrupo',
      old.subgrupo ? `Subgrupo ${old.subgrupo}` : 'Sin subgrupo',
      subgrupo ? `Subgrupo ${subgrupo}` : 'Sin subgrupo',
      null, uid);
  }
  if (becadoVal !== null && Boolean(old.becado) !== becadoVal) {
    await logHistorial(req.params.id, 'cambio_becado',
      old.becado ? 'Becado' : 'No becado',
      becadoVal ? 'Becado' : 'No becado',
      null, uid);
  }
  res.json({ ok:true });
});

// ── CAMBIAR CÉDULA ────────────────────────────────────────────────────
// Endpoint separado porque cambiar cédula es delicado (afecta historial).
// Como la cédula es FK indirecta vía id, cambiarla en estudiantes se propaga
// automáticamente a todas las demás tablas que referencian por id.
// Las tablas que guardan la cédula como texto (prematricula, archivo_*) NO se
// tocan porque son registros históricos independientes.
router.put("/:id/cedula", canManage, async (req, res) => {
  const { cedula_nueva, justificacion } = req.body;
  const u = req.session.usuario;
  const id = req.params.id;

  // Validaciones
  if(!cedula_nueva || !String(cedula_nueva).trim()){
    return res.status(400).json({ error: "La cédula nueva es obligatoria." });
  }
  const ced = String(cedula_nueva).trim();
  // La cédula puede ser numérica (nacional) o alfanumérica (DIMEX/pasaporte)
  if(!/^[A-Za-z0-9\-]{4,20}$/.test(ced)){
    return res.status(400).json({ error: "Cédula inválida (use solo letras, números y guiones, entre 4 y 20 caracteres)." });
  }

  // Verificar que el estudiante existe
  const est = await pool.query("SELECT id, cedula, nombre, primer_apellido FROM estudiantes WHERE id=$1", [id]);
  if(!est.rows.length) return res.status(404).json({ error: "Estudiante no encontrado." });
  const cedulaActual = est.rows[0].cedula;

  if(ced === cedulaActual){
    return res.status(400).json({ error: "La cédula nueva es igual a la actual." });
  }

  // Verificar que la nueva no esté en uso por otro estudiante
  const dup = await pool.query("SELECT id FROM estudiantes WHERE cedula=$1 AND id<>$2", [ced, id]);
  if(dup.rows.length){
    return res.status(409).json({ error: `Esta cédula ya pertenece a otro estudiante registrado (id ${dup.rows[0].id}). Si ese estudiante está duplicado o archivado, contactá al administrador.` });
  }

  try {
    await pool.query("UPDATE estudiantes SET cedula=$1 WHERE id=$2", [ced, id]);
    // Log opcional para auditoría
    console.log(`[CEDULA] Usuario ${u.id} (${u.rol}) cambió cédula de estudiante ${id}: ${cedulaActual} → ${ced}${justificacion?` · Justif: ${justificacion}`:''}`);
    // Historial
    await logHistorial(id, 'cambio_cedula', cedulaActual, ced, justificacion, u.id);
    res.json({ ok: true, cedula_anterior: cedulaActual, cedula_nueva: ced });
  } catch(e) {
    console.error("PUT estudiantes/:id/cedula:", e);
    res.status(500).json({ error: "Error al cambiar la cédula." });
  }
});

// ── ACTUALIZAR BECA COMEDOR (orientadores — solo su sección) ─────
router.put("/:id/becado", require("../middleware/auth").requireRol("admin","auxiliar","orientador"), async (req, res) => {
  const { becado } = req.body;
  const u = req.session.usuario;
  const fx = u.funciones_extra || [];
  const esOrientador = u.rol === "orientador" || fx.includes("orientador");
  if(esOrientador && u.rol !== "admin" && u.rol !== "auxiliar"){
    const secR = await pool.query("SELECT seccion_id FROM estudiantes WHERE id=$1", [req.params.id]);
    if(!secR.rows.length) return res.status(404).json({ error:"No encontrado" });
    const oriSec = await pool.query("SELECT seccion_id FROM seccion_orientador WHERE orientador_id=$1", [u.id]);
    const misSecs = oriSec.rows.map(r=>r.seccion_id);
    if(!misSecs.includes(secR.rows[0].seccion_id))
      return res.status(403).json({ error:"Solo podés modificar estudiantes de tu sección asignada" });
  }
  await pool.query("UPDATE estudiantes SET becado=$1 WHERE id=$2", [!!becado, req.params.id]);
  res.json({ ok: true });
});

// ── CAMBIAR SECCIÓN (solo auxiliar/admin) ────────────────────
router.put("/:id/seccion", canManage, async (req, res) => {
  const { seccion_id, justificacion } = req.body;
  const estId = req.params.id;

  // Obtener info actual del estudiante
  const estR = await pool.query(`
    SELECT e.*, s.nombre AS sec_nombre FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.id=$1
  `, [estId]);
  if (!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
  const est = estR.rows[0];
  const seccionAnteriorId = est.seccion_id;
  const seccionAnteriorNombre = est.sec_nombre || "Sin sección";

  const conflicto = await validarRestriccionSeccionActual(estId,seccion_id);
  if(conflicto) return res.status(409).json({ error:mensajeRestriccionSeccion(conflicto),restriccion:true });

  // Actualizar sección y guardar justificación
  await pool.query(
    "UPDATE estudiantes SET seccion_id=$1, justificacion_cambio_seccion=$2 WHERE id=$3",
    [seccion_id||null, justificacion||null, estId]
  );

  const secNombreNueva = seccion_id
    ? (await pool.query("SELECT nombre FROM secciones WHERE id=$1", [seccion_id])).rows[0]?.nombre
    : "Sin sección";

  const nombreTraslado = `${est.nombre||''} ${est.primer_apellido||''} ${est.segundo_apellido||''}`.replace(/\s+/g,' ').trim();
  const msgAnterior = `🔄 El estudiante ${nombreTraslado} fue trasladado FUERA de la sección ${seccionAnteriorNombre}${justificacion ? ` — Motivo: ${justificacion}` : ""}.`;
  const msgNueva    = `🔄 El estudiante ${nombreTraslado} fue trasladado a la sección ${secNombreNueva}${justificacion ? ` — Motivo: ${justificacion}` : ""}.`;

  // Notificar al guía y solo a docentes que atendían el subgrupo anterior.
  if (seccionAnteriorId) {
    await notificarMovimientoEstudiante(seccionAnteriorId, est.subgrupo, msgAnterior, 'cambio_seccion');
  }

  // Notificar al guía y solo a docentes que atenderán el mismo subgrupo.
  if (seccion_id) {
    await notificarMovimientoEstudiante(seccion_id, est.subgrupo, msgNueva, 'cambio_seccion');
  }

  // Historial
  await logHistorial(estId, 'cambio_seccion', seccionAnteriorNombre, secNombreNueva, justificacion, req.session.usuario?.id);

  res.json({ ok: true });
});

// ── ELIMINAR (baja lógica) ─────────────────────────────────────
router.delete("/:id", canManage, async (req, res) => {
  const { justificacion } = req.body || {};
  if(!justificacion || !justificacion.trim())
    return res.status(400).json({ error:"La justificación de la baja es obligatoria." });

  const u = req.session.usuario;

  // Obtener datos del estudiante antes de desactivar
  const estR = await pool.query(
    "SELECT nombre, primer_apellido, segundo_apellido, cedula FROM estudiantes WHERE id=$1",
    [req.params.id]
  );
  const est = estR.rows[0];
  const nombreEst = est ? `${est.nombre} ${est.primer_apellido} ${est.segundo_apellido} (${est.cedula})`.replace(/\s+/g,' ').trim() : `ID ${req.params.id}`;

  // Desactivar estudiante y guardar auditoría del retiro
  await pool.query(
    "UPDATE estudiantes SET activo=false, retirado_por=$2, fecha_retiro=NOW(), motivo_retiro=$3 WHERE id=$1",
    [req.params.id, u.id, justificacion.trim()]
  );

  // Notificar a todos los admins
  const admins = await pool.query(
    "SELECT id FROM usuarios WHERE rol='admin' AND activo=true"
  );
  const nombreUsuario = `${u.nombre||''} ${u.primer_apellido||''} ${u.segundo_apellido||''}`.replace(/\s+/g,' ').trim();
  const mensaje = `Baja de estudiante: ${nombreEst}. Justificación: ${justificacion.trim()}. Registrado por: ${nombreUsuario}.`;

  for(const admin of admins.rows){
    await pool.query(
      "INSERT INTO notificaciones (usuario_id, mensaje, tipo) VALUES ($1,$2,$3)",
      [admin.id, mensaje, "baja_estudiante"]
    );
  }

  // Historial
  await logHistorial(req.params.id, 'baja', 'Activo', 'Inactivo (baja)', justificacion.trim(), u.id);

  res.json({ ok: true });
});

// ── GUARDAR FOTO ──────────────────────────────────────────────
// Si Cloudinary está configurado, sube la foto ahí y guarda la URL en
// la BD (~100 bytes). Si no, guarda el base64 en la BD como antes.
// El campo `foto_url` en la BD puede contener:
//   - Una URL https://res.cloudinary.com/... (nuevo, Cloudinary)
//   - Un data URI base64 "data:image/jpeg;base64,..." (viejo, en BD)
//   - null (sin foto)
// El frontend usa el valor directo en <img src=...>, así que ambos formatos
// funcionan sin cambios.
router.put("/:id/foto", canManage, async (req, res) => {
  const { foto_url } = req.body;
  if (!foto_url) {
    // Sin foto: limpiar y borrar la de Cloudinary si existía
    await pool.query("UPDATE estudiantes SET foto_url=NULL WHERE id=$1", [req.params.id]);
    if (cldHelper.habilitado()) {
      await cldHelper.borrarFotoEstudiante(req.params.id);
    }
    return res.json({ ok: true });
  }
  // Si Cloudinary está habilitado, subir ahí
  if (cldHelper.habilitado()) {
    const result = await cldHelper.subirFotoEstudiante(req.params.id, foto_url);
    if (result && result.url) {
      await pool.query("UPDATE estudiantes SET foto_url=$1 WHERE id=$2",
        [result.url, req.params.id]);
      return res.json({ ok: true, cloudinary: true, url: result.url });
    }
    // Si falló Cloudinary, fallback: guardar en BD (para no perder la foto)
    console.warn(`⚠️  Fallo Cloudinary al subir foto estudiante ${req.params.id}. Guardando en BD.`);
  }
  // Modo legacy: guardar el base64 en la BD
  await pool.query("UPDATE estudiantes SET foto_url=$1 WHERE id=$2",
    [foto_url, req.params.id]);
  res.json({ ok: true, cloudinary: false });
});

// ── LISTAR ARCHIVADOS ────────────────────────────────────────────────
router.get("/archivados", canManage, async (req, res) => {
  const r = await pool.query(`
    SELECT e.*,
      COALESCE(s.nombre, e.seccion_archivo) AS seccion_nombre,
      u.nombre AS retirado_por_nombre,
      u.primer_apellido AS retirado_por_ap1,
      u.segundo_apellido AS retirado_por_ap2,
      u.rol AS retirado_por_rol
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN usuarios u ON u.id=e.retirado_por
    WHERE e.archivado=true
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
  `);
  res.json(r.rows);
});

// ── ARCHIVAR ESTUDIANTE ──────────────────────────────────────────────
router.post("/:id/archivar", canManage, async (req, res) => {
  const { justificacion, motivo } = req.body || {};
  if(!justificacion || !justificacion.trim())
    return res.status(400).json({ error:"La justificación es obligatoria." });

  const u = req.session.usuario;

  // Obtener datos del estudiante
  const estR = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre, s.id AS sec_id
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.id=$1 AND e.activo=true AND (e.archivado=false OR e.archivado IS NULL)
  `, [req.params.id]);

  if(!estR.rows.length)
    return res.status(404).json({ error:"Estudiante no encontrado o ya archivado." });

  const est = estR.rows[0];
  const nombreEst = `${est.nombre||''} ${est.primer_apellido||''} ${est.segundo_apellido||''}`.replace(/\s+/g,' ').trim();
  const nombreUsuario = `${u.nombre||''} ${u.primer_apellido||''} ${u.segundo_apellido||''}`.replace(/\s+/g,' ').trim();

  // Archivar — mantener activo=true pero archivado=true
  await pool.query(`
    UPDATE estudiantes SET
      archivado=true,
      fecha_archivo=CURRENT_DATE,
      motivo_archivo=$1,
      justificacion_archivo=$2,
      retirado_por=$3,
      fecha_retiro=NOW(),
      motivo_retiro=$1,
      seccion_archivo=$4,
      seccion_id=NULL
    WHERE id=$5
  `, [motivo||null, justificacion.trim(), u.id, est.seccion_nombre||null, req.params.id]);

  // Notificar al guía y solo a docentes que atendían ese subgrupo.
  if(est.sec_id){
    const msg = `El estudiante ${nombreEst} (Sección: ${est.seccion_nombre||''}) ha sido retirado del Liceo de Calle Fallas. Registrado por: ${nombreUsuario}.${motivo?' Motivo: '+motivo:''}`;
    await notificarMovimientoEstudiante(est.sec_id, est.subgrupo, msg, "archivo_estudiante");

    // También notificar admins
    const admins = await pool.query("SELECT id FROM usuarios WHERE rol='admin' AND activo=true");
    for(const a of admins.rows){
      await pool.query(
        "INSERT INTO notificaciones (usuario_id, mensaje, tipo) VALUES ($1,$2,$3)",
        [a.id, msg, "archivo_estudiante"]
      );
    }
  }

  // Historial
  const desc = motivo ? `Retirado del centro — ${motivo}` : 'Retirado del centro';
  await logHistorial(req.params.id, 'archivado',
    `Activo en ${est.seccion_nombre || 'sin sección'}`,
    desc, justificacion.trim(), u.id);

  res.json({ ok:true });
});

// ── REACTIVAR ESTUDIANTE ARCHIVADO ────────────────────────────────────
// Saca al estudiante del archivo. Requiere justificación y opcionalmente
// una sección de destino. Si no se indica sección, queda sin sección
// (el admin/auxiliar la asignará después).
router.post("/:id/reactivar", canManage, async (req, res) => {
  const { justificacion, seccion_id } = req.body || {};
  if (!justificacion || !justificacion.trim())
    return res.status(400).json({ error:"La justificación es obligatoria para reactivar." });

  const u = req.session.usuario;

  const estR = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id = e.seccion_id
    WHERE e.id = $1 AND e.archivado = true
  `, [req.params.id]);

  if (!estR.rows.length)
    return res.status(404).json({ error:"Estudiante no encontrado en archivo." });

  const est = estR.rows[0];
  const nombreEst = `${est.nombre||''} ${est.primer_apellido||''} ${est.segundo_apellido||''}`.replace(/\s+/g,' ').trim();

  // Validar sección si se indicó
  let secNueva = null;
  if (seccion_id) {
    const sR = await pool.query("SELECT id, nombre FROM secciones WHERE id=$1", [seccion_id]);
    if (!sR.rows.length) return res.status(400).json({ error:"Sección destino inválida." });
    secNueva = sR.rows[0];
    const conflicto = await validarRestriccionSeccionActual(req.params.id,secNueva.id);
    if(conflicto) return res.status(409).json({ error:mensajeRestriccionSeccion(conflicto),restriccion:true });
  }

  await pool.query(`
    UPDATE estudiantes SET
      archivado=false,
      fecha_archivo=NULL,
      motivo_archivo=NULL,
      justificacion_archivo=NULL,
      retirado_por=NULL,
      fecha_retiro=NULL,
      motivo_retiro=NULL,
      seccion_id=$1,
      activo=true
    WHERE id=$2
  `, [secNueva ? secNueva.id : null, req.params.id]);

  // Notificar a admins
  const admins = await pool.query("SELECT id FROM usuarios WHERE rol='admin' AND activo=true");
  const nombreUsuario = `${u.nombre||''} ${u.primer_apellido||''} ${u.segundo_apellido||''}`.replace(/\s+/g,' ').trim();
  const msg = `El estudiante ${nombreEst} fue REACTIVADO del archivo${secNueva?' y asignado a la sección '+secNueva.nombre:' (sin sección asignada)'}. Por: ${nombreUsuario}.`;
  for (const a of admins.rows) {
    if (a.id !== u.id) {
      await pool.query(
        "INSERT INTO notificaciones (usuario_id, mensaje, tipo) VALUES ($1,$2,$3)",
        [a.id, msg, "reactivacion_estudiante"]
      );
    }
  }

  // Si tiene sección, notificar al guía y solo a docentes de su subgrupo.
  if (secNueva) {
    await notificarMovimientoEstudiante(secNueva.id, est.subgrupo, msg, "reactivacion_estudiante", u.id);
  }

  // Historial
  await logHistorial(req.params.id, 'reactivado',
    'Archivado',
    secNueva ? `Reactivado en ${secNueva.nombre}` : 'Reactivado (sin sección)',
    justificacion.trim(), u.id);

  res.json({ ok:true, seccion: secNueva });
});
router.put("/:id/asignar-seccion", canManage, async (req, res) => {
  const { seccion_id } = req.body;
  if(!seccion_id) return res.status(400).json({ error:"Sección requerida." });
  const conflicto = await validarRestriccionSeccionActual(req.params.id,seccion_id);
  if(conflicto) return res.status(409).json({ error:mensajeRestriccionSeccion(conflicto),restriccion:true });
  await pool.query(
    "UPDATE estudiantes SET seccion_id=$1 WHERE id=$2",
    [seccion_id, req.params.id]
  );
  res.json({ ok:true });
});


// ── MARCAR/DESMARCAR ESCAPE ─────────────────────────────────────────────────
router.post("/:id/escape", requireAuth, async (req, res) => {
  const { escapado, asignacion_id } = req.body;
  const u = req.session.usuario;
  const estId = parseInt(req.params.id);

  try {
    const estR = await pool.query(`
      SELECT e.*, s.nombre AS seccion_nombre,
        e.primer_apellido, e.segundo_apellido, e.nombre,
        e.boleta_escape_id
      FROM estudiantes e
      LEFT JOIN secciones s ON s.id=e.seccion_id
      WHERE e.id=$1`, [estId]);
    if (!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
    const est = estR.rows[0];

    if (escapado) {
      // ── MARCAR COMO ESCAPADO: generar boleta automática ──────────────────
      const infR = await pool.query(
        "SELECT id FROM infracciones WHERE tipo='leve' AND descripcion ILIKE '%Fuga de las lecciones%' LIMIT 1"
      );
      if (!infR.rows.length) return res.status(500).json({ error: "Infracción 'Fuga de lecciones' no encontrada" });
      const infraccionId = infR.rows[0].id;

      const _crN = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Costa_Rica'}));
      const hoy = _crN.getFullYear()+'-'+String(_crN.getMonth()+1).padStart(2,'0')+'-'+String(_crN.getDate()).padStart(2,'0');

      // Usar asignacion_id para registrar en qué materia se escapó
      const asigId = asignacion_id ? parseInt(asignacion_id) : null;

      const boletaR = await pool.query(`
        INSERT INTO boletas_conducta
          (estudiante_id, infraccion_id, asignacion_id, registrado_por, fecha, observacion)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `, [
        estId, infraccionId, asigId, u.id, hoy,
        'Boleta generada automáticamente por fuga de lecciones.'
      ]);
      const boletaId = boletaR.rows[0].id;

      await pool.query(
        "UPDATE estudiantes SET escapado=true, boleta_escape_id=$1 WHERE id=$2",
        [boletaId, estId]
      );

      // Marcar escapado en la sesión activa de hoy también
      if (asigId) {
        const sesHoyR = await pool.query(
          "SELECT id FROM sesiones_asistencia WHERE asignacion_id=$1 AND fecha=$2",
          [asigId, hoy]
        );
        if (sesHoyR.rows.length) {
          await pool.query(
            "UPDATE asistencia SET escapado=true WHERE sesion_id=$1 AND estudiante_id=$2",
            [sesHoyR.rows[0].id, estId]
          );
        }
      }

      // Notificar al profesor guía de la sección
      // (antes consultaba s.profesor_guia_id que no existe — la relación está en seccion_guia)
      try {
        const guiaR = await pool.query(`
          SELECT profesor_id FROM seccion_guia WHERE seccion_id=$1`, [est.seccion_id]);
        if (guiaR.rows.length && guiaR.rows[0].profesor_id && guiaR.rows[0].profesor_id !== u.id) {
          await pool.query(`
            INSERT INTO notificaciones (usuario_id, tipo, mensaje)
            VALUES ($1, 'conducta', $2)
          `, [
            guiaR.rows[0].profesor_id,
            `⚠️ Boleta automática — ${est.nombre} ${est.primer_apellido} ${est.segundo_apellido} (${est.seccion_nombre || 'Sin sección'}): Fuga de lecciones.`
          ]);
        }
      } catch(e) {
        console.error('notificar-guia-escape error:', e.message);
      }

      await notificarEstudiante(estId, {
        title: "⚠️ Alerta de escape de lección",
        body: "Se registró un escape de lección para {estudiante}. Ingrese al portal para revisar la información.",
        url: "/?app=familias&abrir=conducta",
        tag: `escape-${boletaId}`,
        urgency: "high",
        requireInteraction: true,
      });

      res.json({ ok: true, escapado: true, boleta_id: boletaId });

    } else {
      // ── DESMARCAR ESCAPE: eliminar boleta automática ─────────────────────
      if (est.boleta_escape_id) {
        await pool.query("DELETE FROM boletas_conducta WHERE id=$1", [est.boleta_escape_id]);
      }
      await pool.query(
        "UPDATE estudiantes SET escapado=false, boleta_escape_id=NULL WHERE id=$1", [estId]
      );
      // Resetear escapado en la sesión activa también.
      // asignacion_id viene en req.body; tiene que declararse acá porque la
      // variable asigId del bloque if anterior está fuera de alcance.
      const asigId = asignacion_id ? parseInt(asignacion_id) : null;
      if (asigId) {
        const _crN2 = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Costa_Rica'}));
        const hoy2 = _crN2.getFullYear()+'-'+String(_crN2.getMonth()+1).padStart(2,'0')+'-'+String(_crN2.getDate()).padStart(2,'0');
        const sesHoyR2 = await pool.query(
          "SELECT id FROM sesiones_asistencia WHERE asignacion_id=$1 AND fecha=$2",
          [asigId, hoy2]
        );
        if (sesHoyR2.rows.length) {
          await pool.query(
            "UPDATE asistencia SET escapado=false WHERE sesion_id=$1 AND estudiante_id=$2",
            [sesHoyR2.rows[0].id, estId]
          );
        }
      }
      res.json({ ok: true, escapado: false });
    }
  } catch(err) {
    console.error("escape error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;

// ── IMPORTAR MASIVO DESDE EXCEL ────────────────────────────────────────
router.post("/importar", canManage, async (req, res) => {
  const estudiantes = req.body;
  if(!Array.isArray(estudiantes) || !estudiantes.length)
    return res.status(400).json({ error:"No se enviaron datos" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Obtener cédulas ya activas para ignorarlas
    const activosR = await client.query("SELECT cedula FROM estudiantes WHERE activo=true");
    const activos = new Set(activosR.rows.map(r => r.cedula));

    // Obtener inactivos para reactivar
    const inactivosR = await client.query("SELECT id, cedula FROM estudiantes WHERE activo=false");
    const inactivos = new Map(inactivosR.rows.map(r => [r.cedula, r.id]));

    let insertados = 0, omitidos = 0, reactivados = 0;
    // Contar ingresos por sección para notificación agrupada al final
    const ingresosPorSeccion = new Map(); // seccion_id -> count

    for(const e of estudiantes){
      const { cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento, seccion_id } = e;
      if(!cedula || !nombre || !primer_apellido) { omitidos++; continue; }

      if(activos.has(cedula)){ omitidos++; continue; }

      if(inactivos.has(cedula)){
        // Reactivar
        const conflicto = await validarRestriccionSeccionActual(inactivos.get(cedula),seccion_id,client);
        if(conflicto){
          await client.query("ROLLBACK");
          return res.status(409).json({ error:`No se importó el archivo. ${mensajeRestriccionSeccion(conflicto)}`,restriccion:true });
        }
        await client.query(`
          UPDATE estudiantes SET nombre=$1,primer_apellido=$2,segundo_apellido=$3,
          fecha_nacimiento=$4,seccion_id=$5,activo=true WHERE id=$6
        `, [nombre, primer_apellido, segundo_apellido||'', fecha_nacimiento||null, seccion_id||null, inactivos.get(cedula)]);
        reactivados++;
        if(seccion_id) ingresosPorSeccion.set(seccion_id, (ingresosPorSeccion.get(seccion_id)||0) + 1);
      } else {
        // Insertar nuevo
        const ins = await client.query(`
          INSERT INTO estudiantes (cedula,nombre,primer_apellido,segundo_apellido,fecha_nacimiento,seccion_id)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (cedula) DO NOTHING
          RETURNING id
        `, [cedula, nombre, primer_apellido, segundo_apellido||'', fecha_nacimiento||null, seccion_id||null]);
        if(ins.rows.length){
          insertados++;
          if(seccion_id) ingresosPorSeccion.set(seccion_id, (ingresosPorSeccion.get(seccion_id)||0) + 1);
        } else {
          omitidos++;
        }
      }
    }

    await client.query("COMMIT");

    // Notificación agrupada por sección (una sola notif por sección, no una por estudiante)
    for(const [seccionId, cantidad] of ingresosPorSeccion.entries()){
      try {
        const sec = await pool.query("SELECT nombre FROM secciones WHERE id=$1", [seccionId]);
        const secNombre = sec.rows[0]?.nombre || `ID ${seccionId}`;
        const msg = `🆕 Ingresaron ${cantidad} estudiante${cantidad>1?'s':''} a la sección ${secNombre} (importación masiva).`;
        // La importación actual no incluye el subgrupo; al estar pendiente de
        // clasificación corresponde avisar a toda la sección.
        await notificarMovimientoEstudiante(seccionId, null, msg, 'nuevo_estudiante');
      } catch(e) {
        console.error("Notif importación sección", seccionId, e.message);
      }
    }

    res.json({ ok:true, insertados, reactivados, omitidos });
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

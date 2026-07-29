const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

async function canAccess(req, res, next) {
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error:"No autorizado" });
  if(["admin","auxiliar","administrativo"].includes(u.rol)) return next();
  try {
    const r = await pool.query("SELECT 1 FROM matricula_comite WHERE usuario_id=$1", [u.id]);
    if(r.rows.length) return next();
  } catch(e) { console.error("canAccess matricula:", e.message); }
  return res.status(403).json({ error:"Sin permisos" });
}

// ── LISTAR MATRÍCULAS ─────────────────────────────────────────────────
router.get("/", canAccess, async (req, res) => {
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.tipo_ingreso, e.nivel_matricula, e.matricula_completada, e.idioma, e.tecnologia,
      e.boleta_entregada,
      e.seccion_id, s.nombre AS seccion_nombre, e.created_at
    FROM estudiantes e
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.activo=true AND (e.archivado=false OR e.archivado IS NULL)
    ORDER BY e.primer_apellido, e.nombre
  `);
  res.json(r.rows);
});

// ── CARGAR POR CÉDULA (busca en estudiantes y prematrícula) ──────────
router.get("/cedula/:cedula", canAccess, async (req, res) => {
  const cedula = req.params.cedula.trim();

  // 1. Buscar en estudiantes activos
  const r = await pool.query(`
    SELECT e.*, s.nombre AS seccion_nombre
    FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.cedula=$1 AND e.activo=true
  `, [cedula]);

  if(r.rows.length){
    const encs = await pool.query(
      "SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC",
      [r.rows[0].id]
    );
    return res.json({ fuente:"estudiante", ...r.rows[0], encargados: encs.rows });
  }

  // 2. Buscar en prematrícula
  try {
    const p = await pool.query(`
      SELECT pm.*,
        pe.parentesco, pe.cedula AS enc_cedula,
        pe.nombre AS enc_nombre, pe.primer_apellido AS enc_ap1,
        pe.segundo_apellido AS enc_ap2, pe.nacionalidad AS enc_nacionalidad,
        pe.fecha_nacimiento AS enc_fecha_nac
      FROM prematricula pm
      LEFT JOIN prematricula_encargado pe ON pe.prematricula_id=pm.id
      WHERE pm.cedula=$1
    `, [cedula]);
    if(p.rows.length) return res.json({ fuente:"prematricula", ...p.rows[0] });
  } catch(e) { console.error("matricula GET /cedula prematricula:", e.message); }

  return res.json(null);
});

// ── GUARDAR DATOS DEL ESTUDIANTE (Paso 1) ────────────────────────────
router.post("/guardar", canAccess, async (req, res) => {
  try {
  const {
    cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento,
    sexo, nacionalidad, correo, institucion_procedencia,
    provincia, canton, distrito, direccion_exacta,
    habita_con, habita_con_otro, adecuacion, tipo_ingreso, nivel_matricula,
    enfermedad, medicamento, telefonos_emergencia, encargados
  } = req.body;

  if(!cedula||!nombre||!primer_apellido)
    return res.status(400).json({ error:"Datos incompletos." });

  const uid = req.session.usuario.id;
  
  // Verificar que las columnas nuevas existen (pueden no existir en DB antigua)
  try {
    await pool.query("SELECT sexo, correo, provincia, canton, distrito, direccion_exacta, habita_con, habita_con_otro, adecuacion, tipo_ingreso, nivel_matricula, institucion_procedencia, enfermedad, medicamento, telefonos_emergencia FROM estudiantes LIMIT 0");
  } catch(colErr) {
    return res.status(500).json({ error: "Columnas de matrícula no encontradas en BD. Reiniciá el servidor para aplicar la migración." });
  }

  const existe = await pool.query("SELECT id FROM estudiantes WHERE cedula=$1", [cedula]);
  let estId;

  if(existe.rows.length){
    estId = existe.rows[0].id;
    await pool.query(`
      UPDATE estudiantes SET
        nombre=$1, primer_apellido=$2, segundo_apellido=$3, fecha_nacimiento=$4,
        sexo=$5, nacionalidad=$6, correo=$7, institucion_procedencia=$8,
        provincia=$9, canton=$10, distrito=$11, direccion_exacta=$12,
        habita_con=$13, habita_con_otro=$14, adecuacion=$15, tipo_ingreso=$16,
        nivel_matricula=$17, enfermedad=$18, medicamento=$19,
        telefonos_emergencia=$20, activo=true
      WHERE id=$21
    `, [nombre, primer_apellido, segundo_apellido, fecha_nacimiento||null,
        sexo||null, nacionalidad||null, correo||null, institucion_procedencia||null,
        provincia||null, canton||null, distrito||null, direccion_exacta||null,
        habita_con||null, habita_con_otro||null, adecuacion||'ninguna',
        tipo_ingreso||'regular', nivel_matricula||null,
        enfermedad||null, medicamento||null, telefonos_emergencia||null, estId]);
  } else {
    const r = await pool.query(`
      INSERT INTO estudiantes
        (cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento,
         sexo, nacionalidad, correo, institucion_procedencia,
         provincia, canton, distrito, direccion_exacta,
         habita_con, habita_con_otro, adecuacion, tipo_ingreso, nivel_matricula,
         enfermedad, medicamento, telefonos_emergencia, activo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true)
      RETURNING id
    `, [cedula, nombre, primer_apellido, segundo_apellido, fecha_nacimiento||null,
        sexo||null, nacionalidad||null, correo||null, institucion_procedencia||null,
        provincia||null, canton||null, distrito||null, direccion_exacta||null,
        habita_con||null, habita_con_otro||null, adecuacion||'ninguna',
        tipo_ingreso||'regular', nivel_matricula||null,
        enfermedad||null, medicamento||null, telefonos_emergencia||null]);
    estId = r.rows[0].id;
  }

  // Guardar encargados
  if(Array.isArray(encargados) && encargados.length){
    await pool.query("DELETE FROM encargados WHERE estudiante_id=$1", [estId]);
    for(let i=0; i<encargados.length; i++){
      const e = encargados[i];
      if(!e.nombre) continue;
      await pool.query(`
        INSERT INTO encargados
          (estudiante_id, parentesco, cedula, nombre, primer_apellido,
           segundo_apellido, nacionalidad, profesion, lugar_trabajo,
           telefono, celular, telefono_trabajo, email, es_principal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [estId, e.parentesco||null, e.cedula||null, e.nombre||null, e.primer_apellido||null,
          e.segundo_apellido||null, e.nacionalidad||null, e.profesion||null, e.lugar_trabajo||null,
          e.telefono||null, e.celular||null, e.telefono_trabajo||null, e.email||null, i===0]);
    }
  }

  // Marcar prematrícula como matriculado
  try {
    await pool.query(
      "UPDATE prematricula SET estado='matriculado' WHERE cedula=$1",
      [cedula]
    );
  } catch(e) { console.error("matricula UPDATE prematricula matriculado:", e.message); }

  res.json({ ok:true, estudiante_id: estId });
  } catch(err) {
    console.error('guardar matricula error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GUARDAR BECA COMEDOR ──────────────────────────────────────────────
router.post("/beca-comedor", canAccess, async (req, res) => {
  const { estudiante_id, cedula_estudiante, personas_hogar, tipo_vivienda,
          vive_con, ingreso_mensual, recibe_avancemos, monto_avancemos,
          otros_ingresos, motivos } = req.body;

  const ingreso   = parseFloat(ingreso_mensual)||0;
  const personas  = parseInt(personas_hogar)||1;
  const percapita = personas > 0 ? ingreso/personas : ingreso;

  let clasificacion, resolucion;
  if(percapita < 100000){
    clasificacion="Alta vulnerabilidad";   resolucion="aprobado";
  } else if(percapita <= 180000){
    clasificacion="Vulnerabilidad media";  resolucion="aprobado";
  } else if(percapita <= 300000){
    clasificacion="Vulnerabilidad baja";   resolucion="pendiente";
  } else {
    clasificacion="Fuera de prioridad";    resolucion="pendiente";
  }

  try {
    await pool.query(`
      INSERT INTO solicitud_beca_comedor
        (estudiante_id, cedula_estudiante, personas_hogar, tipo_vivienda, vive_con,
         ingreso_mensual, recibe_avancemos, monto_avancemos, otros_ingresos, motivos,
         ingreso_percapita, clasificacion, resolucion, registrado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [estudiante_id||null, cedula_estudiante||null, personas, tipo_vivienda||null,
        vive_con||null, ingreso, recibe_avancemos||false, monto_avancemos||0,
        otros_ingresos||null, motivos||null, percapita, clasificacion,
        resolucion, req.session.usuario.id]);
  } catch(e) {
    console.error('beca-comedor INSERT error:', e.message);
    return res.status(500).json({ error: "No se pudo guardar la solicitud: " + e.message });
  }

  // Sincronizar el campo `becado` del estudiante con la resolución actual:
  // aprobado → becado=true; pendiente o rechazado → becado=false
  // (antes solo marcaba a true; si la situación cambiaba, la beca quedaba pegada)
  if(estudiante_id){
    try {
      await pool.query("UPDATE estudiantes SET becado=$1 WHERE id=$2",
        [resolucion === "aprobado", estudiante_id]);
    } catch(e){ console.error('beca-comedor UPDATE estudiante:', e.message); }
  }

  res.json({ ok:true, percapita, clasificacion, resolucion });
});

// ── GUARDAR ADECUACIÓN ────────────────────────────────────────────────
router.post("/adecuacion", canAccess, async (req, res) => {
  const { estudiante_id, motivo, antecedentes } = req.body;
  try {
    await pool.query(`
      INSERT INTO solicitud_adecuacion (estudiante_id, motivo, antecedentes, registrado_por)
      VALUES ($1,$2,$3,$4)
    `, [estudiante_id||null, motivo||null, antecedentes||null, req.session.usuario.id]);
    if(estudiante_id)
      await pool.query("UPDATE estudiantes SET adecuacion='significativa' WHERE id=$1", [estudiante_id]);
  } catch(e) {
    console.error('adecuacion error:', e.message);
    return res.status(500).json({ error: "No se pudo guardar la solicitud: " + e.message });
  }
  res.json({ ok:true });
});

// ── COMPLETAR MATRÍCULA ───────────────────────────────────────────────
router.post("/completar/:id", canAccess, async (req, res) => {
  await pool.query("UPDATE estudiantes SET matricula_completada=true WHERE id=$1", [req.params.id]);
  res.json({ ok:true });
});

// ── ELIMINAR MATRÍCULA (soft delete) ─────────────────────────────────
router.delete("/:id", canAccess, async (req, res) => {
  const { justificacion } = req.body || {};
  if(!justificacion?.trim())
    return res.status(400).json({ error:"La justificación es obligatoria." });
  const r = await pool.query("SELECT id FROM estudiantes WHERE id=$1", [req.params.id]);
  if(!r.rows.length) return res.status(404).json({ error:"No encontrado." });
  // Get cedula to revert prematricula
  const est = await pool.query("SELECT cedula FROM estudiantes WHERE id=$1", [req.params.id]);
  await pool.query("UPDATE estudiantes SET activo=false, matricula_completada=false WHERE id=$1", [req.params.id]);
  // Revertir estado de prematrícula si existe
  if(est.rows.length) {
    try {
      await pool.query(
        "UPDATE prematricula SET estado='pendiente' WHERE cedula=$1 AND estado='matriculado'",
        [est.rows[0].cedula]
      );
    } catch(e) { console.error("matricula UPDATE prematricula pendiente:", e.message); }
  }
  res.json({ ok:true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  MATRÍCULA CON SECCIÓN POR AÑO (cupos, idioma, tecnología)
// ═══════════════════════════════════════════════════════════════════════════

const MAX_CUPO = 26; // máximo de estudiantes por sección

// Fecha/año actual en Costa Rica (UTC-6)
function fechaCR(){
  const ahora = new Date();
  const offsetCR = -6 * 60;
  const localMs = ahora.getTime() + (ahora.getTimezoneOffset() + offsetCR) * 60000;
  return new Date(localMs).toISOString().slice(0,10);
}
function anioActualCR(){ return parseInt(fechaCR().slice(0,4)); }

// Subgrupo según tecnología:
//   Inglés Conversacional = A
//   Diseño Publicitario   = B
//   Matem/AMPROSA         = B (misma B — por sección se elige UNA de las dos B)
function subgrupoDeTecnologia(tec){
  if(!tec) return null;
  if(/conversacional/i.test(tec)) return 'A';
  if(/publicitario/i.test(tec)) return 'B';
  if(/amprosa|matem/i.test(tec)) return 'B';
  return null;
}

// ── CUPOS POR SECCIÓN PARA UN AÑO (con desglose por subgrupo A/B) ────────
// Año actual → cuenta estudiantes activos en cada sección.
// Año futuro → cuenta filas de matrícula de ese año.
// Cupo máximo total: 26 · Máximo por subgrupo (A o B): 13
router.get("/cupos/:anio", canAccess, async (req, res) => {
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error: "Año inválido" });
  const esActual = anio === anioActualCR();
  const q = esActual ? `
    SELECT s.id AS seccion_id, s.nombre, s.nivel, si.idioma, sc.tec_b,
      COUNT(e.id)::int AS ocupados,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(e.subgrupo,'')) = 'A')::int AS ocupados_a,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(e.subgrupo,'')) = 'B')::int AS ocupados_b
    FROM secciones s
    LEFT JOIN secciones_idioma si ON si.seccion_id = s.id AND si.anio = $1
    LEFT JOIN secciones_config sc ON sc.seccion_id = s.id AND sc.anio = $1
    LEFT JOIN estudiantes e ON e.seccion_id = s.id
      AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
    GROUP BY s.id, si.idioma, sc.tec_b ORDER BY s.nivel, s.nombre
  ` : `
    SELECT s.id AS seccion_id, s.nombre, s.nivel, si.idioma, sc.tec_b,
      COUNT(m.id)::int AS ocupados,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(m.subgrupo,'')) = 'A')::int AS ocupados_a,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(m.subgrupo,'')) = 'B')::int AS ocupados_b
    FROM secciones s
    LEFT JOIN secciones_idioma si ON si.seccion_id = s.id AND si.anio = $1
    LEFT JOIN secciones_config sc ON sc.seccion_id = s.id AND sc.anio = $1
    LEFT JOIN matricula m ON m.seccion_id = s.id AND m.anio = $1
    GROUP BY s.id, si.idioma, sc.tec_b ORDER BY s.nivel, s.nombre
  `;
  const r = await pool.query(q, [anio]);
  const MAX_SUB = 13;
  res.json(r.rows.map(x => ({
    ...x,
    max: MAX_CUPO,
    max_subgrupo: MAX_SUB,
    disponibles: Math.max(0, MAX_CUPO - x.ocupados),
    disponibles_a: Math.max(0, MAX_SUB - x.ocupados_a),
    disponibles_b: Math.max(0, MAX_SUB - x.ocupados_b),
  })));
});

// ── ASIGNAR SECCIÓN (año actual o futuro) ────────────────────────────────
// body: { estudiante_id, anio, seccion_id, idioma, tecnologia, forzar }
// - Año actual  → actualiza estudiantes.seccion_id directamente (comportamiento clásico)
// - Año futuro  → guarda en la tabla matricula; NO toca la sección vigente.
//   El cambio real ocurre con POST /aplicar/:anio al arrancar el año nuevo.
// - Cupo máximo 26. Solo admin puede forzar por encima del cupo (forzar=true).
router.post("/asignar", canAccess, async (req, res) => {
  const { estudiante_id, anio, seccion_id, idioma, tecnologia, forzar } = req.body;
  const a = parseInt(anio);
  if(!estudiante_id || !a || !seccion_id)
    return res.status(400).json({ error: "estudiante_id, anio y seccion_id son requeridos" });

  const u = req.session.usuario;
  const esActual = a === anioActualCR();

  // ── Verificar cupos (excluyendo al propio estudiante) ──────────────────
  // Cupo total 26 + cupo por subgrupo 13 (aplica en 10° y 11° con tecnologías)
  const MAX_SUB = 13;
  const sub = subgrupoDeTecnologia(tecnologia);
  let ocupados, ocupadosSub = 0;
  if(esActual){
    const c = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(subgrupo,'')) = $3)::int AS sub_c
      FROM estudiantes
      WHERE seccion_id=$1 AND activo=true AND (archivado=false OR archivado IS NULL) AND id<>$2
    `, [seccion_id, estudiante_id, (sub||'').toUpperCase()]);
    ocupados = c.rows[0].total;
    ocupadosSub = c.rows[0].sub_c;
  } else {
    const c = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(subgrupo,'')) = $4)::int AS sub_c
      FROM matricula WHERE seccion_id=$1 AND anio=$2 AND estudiante_id<>$3
    `, [seccion_id, a, estudiante_id, (sub||'').toUpperCase()]);
    ocupados = c.rows[0].total;
    ocupadosSub = c.rows[0].sub_c;
  }
  if(ocupados >= MAX_CUPO && !(forzar && u.rol === "admin")){
    return res.status(409).json({
      error: `La sección está llena (${ocupados}/${MAX_CUPO}). Solo el administrador puede forzar la matrícula por encima del cupo.`,
      llena: true
    });
  }
  if(sub && ocupadosSub >= MAX_SUB && !(forzar && u.rol === "admin")){
    return res.status(409).json({
      error: `El Grupo ${sub} de esta sección ya está lleno (${ocupadosSub}/${MAX_SUB}). Solo el administrador puede forzar por encima del cupo del subgrupo.`,
      subgrupo_lleno: true
    });
  }

  const secR = await pool.query("SELECT nombre FROM secciones WHERE id=$1", [seccion_id]);
  const secNombre = secR.rows[0] ? secR.rows[0].nombre : "";
  // Idioma exclusivo de la sección PARA ESE AÑO (2026: 10-3/11-3 · 2027: 10-2/11-2)
  const secIdR = await pool.query(
    "SELECT idioma FROM secciones_idioma WHERE seccion_id=$1 AND anio=$2", [seccion_id, a]);
  const secIdioma = secIdR.rows[0] ? secIdR.rows[0].idioma : null;
  // Config A/B de la sección para ese año (qué tecnología B ofrece, qué talleres)
  const secCfgR = await pool.query(
    "SELECT tec_b FROM secciones_config WHERE seccion_id=$1 AND anio=$2", [seccion_id, a]);
  const secTecB = secCfgR.rows[0] ? secCfgR.rows[0].tec_b : null;

  // Si la sección tiene configurada su tecnología B, la del estudiante debe coincidir
  // (Inglés Conversacional siempre pasa porque es A y no aplica esta validación)
  if(tecnologia && sub === 'B' && secTecB && tecnologia !== secTecB && !(forzar && u.rol === "admin")){
    return res.status(409).json({
      error: `La sección ${secNombre} ofrece "${secTecB}" como Grupo B, pero el estudiante seleccionó "${tecnologia}". Cambie la tecnología del estudiante o elija otra sección.`,
      tec_conflicto: true
    });
  }

  // ── Validación de idioma (secciones exclusivas de Francés) ────────────
  // Idioma efectivo del estudiante: el que viene en la asignación, o el
  // que ya tiene registrado (digitado por la orientadora de 9°).
  const estIdR = await pool.query("SELECT idioma FROM estudiantes WHERE id=$1", [estudiante_id]);
  const idiomaEf = idioma || (estIdR.rows[0] ? estIdR.rows[0].idioma : null);
  const secEsFrances = secIdioma === "Francés";
  const estEsFrances = idiomaEf === "Francés";
  if(secEsFrances !== estEsFrances && !(forzar && u.rol === "admin")){
    const msg = secEsFrances
      ? `La sección ${secNombre} es EXCLUSIVA de Francés y el estudiante lleva ${idiomaEf || "idioma sin registrar"}.`
      : `El estudiante lleva Francés y la sección ${secNombre} no es de Francés.`;
    return res.status(409).json({ error: msg + " Solo el administrador puede forzar esta asignación.", idioma_conflicto: true });
  }

  if(esActual){
    // Asignación inmediata + actualiza idioma/tecnología del estudiante
    await pool.query(`
      UPDATE estudiantes SET seccion_id=$1,
        idioma = COALESCE($2, idioma),
        tecnologia = COALESCE($3, tecnologia)
      WHERE id=$4
    `, [seccion_id, idioma || null, tecnologia || null, estudiante_id]);
  }
  // En ambos casos queda registrado en la tabla matricula (historial por año)
  await pool.query(`
    INSERT INTO matricula (estudiante_id, anio, seccion_id, seccion_nombre, idioma, tecnologia, subgrupo, confirmado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (estudiante_id, anio) DO UPDATE SET
      seccion_id=$3, seccion_nombre=$4,
      idioma=COALESCE($5, matricula.idioma),
      tecnologia=COALESCE($6, matricula.tecnologia),
      subgrupo=COALESCE($7, matricula.subgrupo),
      confirmado_por=$8
  `, [estudiante_id, a, seccion_id, secNombre, idioma || null, tecnologia || null, sub, u.id]);

  res.json({ ok: true, aplicado_directo: esActual, seccion_nombre: secNombre, subgrupo: sub });
});

// ── ASIGNACIONES FUTURAS DE UN AÑO (para pintar la lista) ────────────────
router.get("/asignaciones/:anio", canAccess, async (req, res) => {
  const anio = parseInt(req.params.anio);
  const r = await pool.query(`
    SELECT m.estudiante_id, m.seccion_id, m.seccion_nombre, m.idioma, m.tecnologia, m.subgrupo
    FROM matricula m WHERE m.anio=$1
  `, [anio]);
  res.json(r.rows);
});

// ── APLICAR MATRÍCULAS DE UN AÑO (solo admin, un botón al arrancar) ──────
// 1. ARCHIVAR resumen académico del año anterior (nota por materia/período + faltas)
//    en la tabla `expediente_academico`. Este resumen lo consultan auxiliares/admin
//    desde el Expediente del estudiante (tab "Historial Académico").
// 2. BORRAR los datos crudos del año anterior (asistencia diaria, evaluaciones,
//    notas) para no acumular volumen en la BD.
// 3. Cada estudiante con matrícula+sección del año nuevo pasa a su sección.
// 4. Los estudiantes activos SIN matrícula quedan SIN SECCIÓN.
// 5. Se LIMPIAN los vínculos de profesor guía y orientador.
// 6. Se BORRAN las asignaciones viejas (con todos sus datos ligados por CASCADE).
router.post("/aplicar/:anio", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if(u.rol !== "admin") return res.status(403).json({ error: "Solo el administrador puede aplicar matrículas" });
  const anio = parseInt(req.params.anio);
  if(!anio) return res.status(400).json({ error: "Año inválido" });
  const anioAnt = anio - 1;

  // Importar calculadora de promedios del módulo calificaciones (para el resumen)
  const { calcularPromediosParaArchivo } = require("./calificaciones");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. ARCHIVAR RESUMEN ACADÉMICO DEL AÑO ANTERIOR ─────────────────
    // Por cada asignación activa (del año en curso, que es el que estamos
    // cerrando), calculamos su promedio por período y guardamos el resumen
    // por cada estudiante activo de esa sección/subgrupo.
    const asigsR = await client.query(`
      SELECT a.id AS asig_id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.periodo,
        s.nombre AS seccion_nombre, m.nombre AS materia_nombre,
        u.primer_apellido AS prof_ap1, u.nombre AS prof_nombre
      FROM asignaciones a
      JOIN secciones s ON s.id = a.seccion_id
      JOIN materias m ON m.id = a.materia_id
      JOIN usuarios u ON u.id = a.profesor_id
      WHERE (a.activa = true OR a.activa IS NULL)
    `);

    let archivadas = 0, saltadas = 0;
    for(const a of asigsR.rows){
      try {
        // Calcular promedios por estudiante (usando la lógica existente)
        const data = await calcularPromediosParaArchivo(client, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.periodo);
        if(!data || !data.estudiantes){ saltadas++; continue; }
        const profNom = `${a.prof_ap1||''} ${a.prof_nombre||''}`.trim();
        for(const est of data.estudiantes){
          const rb = est.rubros || {};
          await client.query(`
            INSERT INTO expediente_academico (
              estudiante_id, anio, periodo, seccion_nombre, materia_nombre, profesor_nombre,
              nota_cotidiano, nota_tareas, nota_pruebas, nota_proyecto, nota_asistencia, nota_total,
              ausencias, ausencias_just, tardias
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            ON CONFLICT (estudiante_id, anio, periodo, materia_nombre) DO UPDATE SET
              seccion_nombre = EXCLUDED.seccion_nombre,
              profesor_nombre = EXCLUDED.profesor_nombre,
              nota_cotidiano = EXCLUDED.nota_cotidiano,
              nota_tareas = EXCLUDED.nota_tareas,
              nota_pruebas = EXCLUDED.nota_pruebas,
              nota_proyecto = EXCLUDED.nota_proyecto,
              nota_asistencia = EXCLUDED.nota_asistencia,
              nota_total = EXCLUDED.nota_total,
              ausencias = EXCLUDED.ausencias,
              ausencias_just = EXCLUDED.ausencias_just,
              tardias = EXCLUDED.tardias
          `, [
            est.estudiante_id, anioAnt, a.periodo, a.seccion_nombre, a.materia_nombre, profNom,
            rb.cotidiano ? rb.cotidiano.nota_100 : null,
            rb.tarea     ? rb.tarea.nota_100     : null,
            rb.examen    ? rb.examen.nota_100    : null,
            rb.proyecto  ? rb.proyecto.nota_100  : null,
            est.asistencia ? est.asistencia.puntos_mep : null,
            est.total || null,
            est.asistencia ? (est.asistencia.lecciones_ausentes_injust || 0) : 0,
            0, // ausencias_just: no está en el struct, quedaría en cero (se puede completar después si es útil)
            0  // tardias: idem
          ]);
          archivadas++;
        }
      } catch(e) {
        console.warn(`Archivo asig ${a.asig_id}:`, e.message);
        saltadas++;
      }
    }

    // Resumen de conducta por período/año → guardar como una "materia virtual" Conducta
    try {
      const conductaR = await client.query(`
        SELECT b.estudiante_id, b.fecha, i.puntos, e.seccion_id, s.nombre AS seccion_nombre
        FROM boletas_conducta b
        JOIN infracciones i ON i.id = b.infraccion_id
        LEFT JOIN estudiantes e ON e.id = b.estudiante_id
        LEFT JOIN secciones s ON s.id = e.seccion_id
      `);
      const rangosI  = { desde: `${anioAnt}-02-23`, hasta: `${anioAnt}-07-03` };
      const rangosII = { desde: `${anioAnt}-07-20`, hasta: `${anioAnt}-12-09` };
      const enRango = (b, rg) => String(b.fecha).slice(0,10) >= rg.desde && String(b.fecha).slice(0,10) <= rg.hasta;
      const porEst = {};
      conductaR.rows.forEach(b => {
        if(!porEst[b.estudiante_id]) porEst[b.estudiante_id] = { I: 0, II: 0, secc: b.seccion_nombre };
        if(enRango(b, rangosI))  porEst[b.estudiante_id].I  += (b.puntos||0);
        if(enRango(b, rangosII)) porEst[b.estudiante_id].II += (b.puntos||0);
      });
      for(const [eid, dat] of Object.entries(porEst)){
        for(const [per, key] of [['I Período','I'],['II Período','II']]){
          const nota = Math.max(0, 100 - dat[key]);
          await client.query(`
            INSERT INTO expediente_academico (
              estudiante_id, anio, periodo, seccion_nombre, materia_nombre,
              nota_total, conducta_nota
            ) VALUES ($1,$2,$3,$4,'Conducta',$5,$5)
            ON CONFLICT (estudiante_id, anio, periodo, materia_nombre) DO UPDATE SET
              seccion_nombre = EXCLUDED.seccion_nombre,
              nota_total = EXCLUDED.nota_total,
              conducta_nota = EXCLUDED.conducta_nota
          `, [parseInt(eid), anioAnt, per, dat.secc, nota]);
        }
      }
    } catch(e) { console.warn("Archivo conducta:", e.message); }

    // ── 2. BORRAR DATOS CRUDOS DEL AÑO ANTERIOR ───────────────────────
    // Todo ligado a asignaciones se borra en cascada al eliminar la asignación.
    // Pero antes borro explícitamente lo que no cae por cascade para tener control:
    //   - sesiones_asistencia y asistencia (cascade desde asignaciones)
    //   - evaluaciones, indicadores, notas_examen, notas_indicador (cascade)
    //   - boletas_conducta ligadas a asignaciones (cascade); las sin asignación → borrar todas
    const boletasBorradas = await client.query("DELETE FROM boletas_conducta RETURNING id");

    // ── 3. Estudiantes → nueva sección + idioma/tecnología/subgrupo ───
    const apl = await client.query(`
      UPDATE estudiantes e SET
        seccion_id = m.seccion_id,
        idioma     = COALESCE(m.idioma, e.idioma),
        tecnologia = COALESCE(m.tecnologia, e.tecnologia),
        subgrupo   = COALESCE(m.subgrupo, e.subgrupo)
      FROM matricula m
      WHERE m.estudiante_id = e.id AND m.anio = $1 AND m.seccion_id IS NOT NULL
        AND e.activo = true
      RETURNING e.id
    `, [anio]);

    // ── 4. Activos sin matrícula → sin sección ────────────────────────
    const sinMat = await client.query(`
      UPDATE estudiantes SET seccion_id = NULL
      WHERE activo = true AND (archivado = false OR archivado IS NULL)
        AND id NOT IN (SELECT estudiante_id FROM matricula WHERE anio = $1 AND seccion_id IS NOT NULL)
      RETURNING id
    `, [anio]);

    // ── 5. Limpiar guía y orientador ──────────────────────────────────
    const guiaClean = await client.query("DELETE FROM seccion_guia RETURNING seccion_id");
    const oriClean  = await client.query("DELETE FROM seccion_orientador RETURNING seccion_id");

    // ── 5.b. Borrar horarios del año anterior (los del año nuevo, si el
    //         admin ya los creó por adelantado, quedan intactos) ─────────
    const horBorrados = await client.query(
      "DELETE FROM horarios WHERE anio = $1 OR anio IS NULL RETURNING id",
      [anioAnt]
    );

    // ── 6. BORRAR asignaciones del año anterior (cascade borra sesiones,
    //         notas, evaluaciones ligadas). Las del año NUEVO que el admin
    //         haya preparado quedan intactas para que los profes arranquen
    //         febrero con todo listo. ─────────────────────────────────────
    const asigBorradas = await client.query(
      "DELETE FROM asignaciones WHERE COALESCE(anio, $1) = $1 RETURNING id",
      [anioAnt]
    );

    // Contar cuántas asignaciones del año nuevo ya estaban preparadas
    const asigNuevas = await client.query(
      "SELECT COUNT(*)::int AS c FROM asignaciones WHERE anio = $1", [anio]
    );

    await client.query("COMMIT");
    res.json({
      ok: true,
      aplicados: apl.rows.length,
      sin_seccion: sinMat.rows.length,
      guias_limpiadas: guiaClean.rows.length,
      orientadores_limpiados: oriClean.rows.length,
      asignaciones_borradas: asigBorradas.rows.length,
      asignaciones_nuevas_preparadas: asigNuevas.rows[0].c,
      boletas_borradas: boletasBorradas.rows.length,
      horarios_borrados: horBorrados.rows.length,
      resumenes_archivados: archivadas,
      resumenes_saltados: saltadas,
      anio,
      anio_archivado: anioAnt
    });
  } catch(e) {
    await client.query("ROLLBACK");
    console.error("Aplicar matrículas:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── SECCIONES DE FRANCÉS POR AÑO ─────────────────────────────────────────
// GET: marcas del año. PUT (solo admin): marcar/desmarcar una sección.
router.get("/secciones-idioma/:anio", canAccess, async (req, res) => {
  const r = await pool.query(
    "SELECT seccion_id, idioma FROM secciones_idioma WHERE anio=$1", [parseInt(req.params.anio)]);
  res.json(r.rows);
});

router.put("/secciones-idioma", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if(u.rol !== "admin") return res.status(403).json({ error: "Solo el administrador puede marcar secciones de idioma" });
  const { seccion_id, anio, idioma } = req.body;
  const a = parseInt(anio);
  if(!seccion_id || !a) return res.status(400).json({ error: "seccion_id y anio requeridos" });
  if(idioma && idioma !== "Francés")
    return res.status(400).json({ error: "Idioma inválido (solo 'Francés' o vacío)" });
  if(idioma){
    await pool.query(`
      INSERT INTO secciones_idioma (seccion_id, anio, idioma) VALUES ($1,$2,$3)
      ON CONFLICT (seccion_id, anio) DO UPDATE SET idioma=$3
    `, [seccion_id, a, idioma]);
  } else {
    await pool.query("DELETE FROM secciones_idioma WHERE seccion_id=$1 AND anio=$2", [seccion_id, a]);
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  IDIOMA Y TECNOLOGÍA — módulo de la orientadora de 9° (9° → 10°)
// ═══════════════════════════════════════════════════════════════════════════

// Middleware de LECTURA: admin, auxiliar, administrativo, orientador (todos ven)
async function canIdiomaTec(req, res, next){
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error: "No autorizado" });
  const fx = u.funciones_extra || [];
  if(["admin","auxiliar","administrativo"].includes(u.rol)) return next();
  if(u.rol === "orientador" || fx.includes("orientador")) return next();
  return res.status(403).json({ error: "Sin permisos" });
}

// Middleware de ESCRITURA: solo admin, administrativo y orientador
// (auxiliares SOLO ven, no editan idioma/tecnología/boleta desde este módulo)
async function canEditarIdiomaTec(req, res, next){
  const u = req.session.usuario;
  if(!u) return res.status(401).json({ error: "No autorizado" });
  const fx = u.funciones_extra || [];
  if(["admin","administrativo"].includes(u.rol)) return next();
  if(u.rol === "orientador" || fx.includes("orientador")) return next();
  return res.status(403).json({ error: "Los auxiliares tienen acceso de solo lectura en este módulo. Para modificar idioma/tecnología, hacelo desde el módulo de Matrícula al asignar la sección." });
}

// Lista estudiantes de NOVENO. Orientador → solo sus secciones asignadas.
// Auxiliares y administrativos → todas las secciones (solo lectura).
router.get("/idioma-tecnologia", canIdiomaTec, async (req, res) => {
  const u = req.session.usuario;
  const fx = u.funciones_extra || [];
  const esOrientador = (u.rol === "orientador" || fx.includes("orientador")) &&
                       !["admin","auxiliar","administrativo"].includes(u.rol);
  const puedeEditar = ["admin","administrativo"].includes(u.rol) ||
                      u.rol === "orientador" || fx.includes("orientador");
  let filtro = "", params = [];
  if(esOrientador){
    const secs = await pool.query("SELECT seccion_id FROM seccion_orientador WHERE orientador_id=$1", [u.id]);
    if(!secs.rows.length) return res.json({ puede_editar: puedeEditar, estudiantes: [] });
    params.push(secs.rows.map(r=>r.seccion_id));
    filtro = `AND e.seccion_id = ANY($${params.length}::int[])`;
  }
  const r = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.idioma, e.tecnologia, e.boleta_entregada, s.nombre AS seccion_nombre
    FROM estudiantes e
    JOIN secciones s ON s.id = e.seccion_id
    WHERE e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
      AND s.nivel = 9 ${filtro}
    ORDER BY s.nombre, e.primer_apellido, e.segundo_apellido, e.nombre
  `, params);
  res.json({ puede_editar: puedeEditar, estudiantes: r.rows });
});

// Guardar idioma/tecnología de un estudiante (autosave por fila) — solo editores
router.put("/idioma-tecnologia/:id", canEditarIdiomaTec, async (req, res) => {
  const { idioma, tecnologia } = req.body;
  await pool.query(`
    UPDATE estudiantes SET idioma=$1, tecnologia=$2 WHERE id=$3
  `, [idioma || null, tecnologia || null, req.params.id]);
  res.json({ ok: true });
});

// Marcar/desmarcar boleta entregada (autosave) — admin/administrativo/auxiliar/orientador
// (auxiliar sí puede marcar cuando recibe la boleta al momento de matricular)
router.put("/boleta-entregada/:id", canIdiomaTec, async (req, res) => {
  const { entregada } = req.body;
  await pool.query("UPDATE estudiantes SET boleta_entregada=$1 WHERE id=$2",
    [entregada ? true : false, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;

const router = require("express").Router();
const { pool } = require("../db");
const { requireDocente } = require("../middleware/auth");
const { obtenerAnioActivo, obtenerPeriodoActual, obtenerCalendario, fechaCR } = require("../utils/lectivo");

const FUNDAMENTO_CONVOCATORIA = "Sección VII del Capítulo II del REAC: para tener derecho a la prueba de ampliación debe haberse asistido al menos al 80% de las lecciones impartidas en la asignatura; artículo 60 para la estrategia de promoción.";

// Detecta el período lectivo actual según la fecha del servidor.
// I Período: 23/feb – 3/jul, II Período: 20/jul – 9/dic. Fuera de eso, último cerrado.
async function periodoActual() { return obtenerPeriodoActual(); }

async function rangoCursoHastaHoy(anio = null) {
  const a = Number(anio) || await obtenerAnioActivo();
  const cal = await obtenerCalendario(a);
  const desde = cal.periodo_i_inicio || `${a}-01-01`;
  const finCurso = cal.periodo_ii_fin || `${a}-12-31`;
  const hoy = fechaCR();
  const hasta = hoy < desde ? desde : (hoy > finCurso ? finCurso : hoy);
  return { nombre:"Curso lectivo a la fecha", anio:a, desde, hasta };
}

async function calcularAusentismo(asignacionId, estudianteId, usuario, permitirAdmin = true) {
  const anio = await obtenerAnioActivo();
  const esAdmin = permitirAdmin && usuario.rol === 'admin';
  const asig = await pool.query(`
    SELECT a.id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.anio,
      m.nombre AS materia, s.nombre AS seccion_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2
    FROM asignaciones a
    JOIN materias m ON m.id=a.materia_id
    JOIN secciones s ON s.id=a.seccion_id
    JOIN usuarios u ON u.id=a.profesor_id
    JOIN secciones_anio san ON san.seccion_id=a.seccion_id AND san.anio=$3 AND san.activa=true
    WHERE a.id=$1 AND a.anio=$3 AND COALESCE(a.activa,true)=true ${esAdmin ? '' : 'AND a.profesor_id=$2'}
  `, [asignacionId, usuario.id, anio]);
  if(!asig.rows.length) return null;
  const a = asig.rows[0];
  const est = await pool.query(`
    SELECT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,e.subgrupo,
      e.activo,e.archivado
    FROM estudiantes e
    WHERE e.id=$1 AND e.seccion_id=$2
  `, [estudianteId,a.seccion_id]);
  if(!est.rows.length) return null;
  const sgAsig = String(a.subgrupo||'').trim().toUpperCase();
  const sgEst = String(est.rows[0].subgrupo||'').trim().toUpperCase();
  if(sgAsig && sgEst && sgAsig !== sgEst) return null;

  const rango = await rangoCursoHastaHoy(anio);
  const stats = await pool.query(`
    SELECT COALESCE(SUM(sa.lecciones),0)::int AS total_lecciones,
      COALESCE(SUM(COALESCE(ast.lecciones_ausentes,sa.lecciones))
        FILTER (WHERE ast.estado='A' AND NOT ast.justificada),0)::int AS ausencias
    FROM sesiones_asistencia sa
    JOIN asignaciones ax ON ax.id=sa.asignacion_id
    LEFT JOIN asistencia ast ON ast.sesion_id=sa.id AND ast.estudiante_id=$1
    WHERE ax.anio=$4 AND ax.profesor_id=$5 AND ax.seccion_id=$6 AND ax.materia_id=$7
      AND COALESCE(ax.subgrupo,'')=COALESCE($8::text,'')
      AND sa.fecha BETWEEN $2 AND $3
  `, [estudianteId,rango.desde,rango.hasta,anio,a.profesor_id,a.seccion_id,a.materia_id,a.subgrupo||null]);
  const total = Number(stats.rows[0].total_lecciones)||0;
  const ausencias = Number(stats.rows[0].ausencias)||0;
  const porcentaje = total ? Math.round((ausencias/total)*10000)/100 : 0;
  return { asignacion:a, estudiante:est.rows[0], rango, total_lecciones:total, ausencias, porcentaje };
}

// ── DATOS PRE-LLENADOS para el formulario ─────────────────────────────────────
// Devuelve la info del estudiante + cálculo de ausencias del período actual
// en la asignación del profesor que consulta. Si el profesor tiene varias
// materias con ese estudiante, devuelve todas y el frontend elige.
router.get("/datos/:estudiante_id", requireDocente, async (req, res) => {
  const estId = parseInt(req.params.estudiante_id);
  if (!estId) return res.status(400).json({ error: "estudiante_id inválido" });

  try {
    const p = await rangoCursoHastaHoy();
    const periodoVigente = (await periodoActual()).nombre;
    const anioActivo = await obtenerAnioActivo();
    const u = req.session.usuario;

    // Estudiante + sección + primer encargado.
    // No filtramos por activo=true porque puede ser un retirado/archivado
    // del cual se necesite generar una carta histórica.
    const estR = await pool.query(`
      SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido, e.subgrupo,
        s.id AS seccion_id, s.nombre AS seccion_nombre, e.activo, e.archivado
      FROM estudiantes e
      LEFT JOIN secciones s ON s.id=e.seccion_id
      WHERE e.id=$1`, [estId]);
    if (!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado" });
    const est = estR.rows[0];

    const encR = await pool.query(`
      SELECT nombre, primer_apellido, segundo_apellido, cedula, parentesco
      FROM encargados WHERE estudiante_id=$1
      ORDER BY es_principal DESC, id ASC LIMIT 1`, [estId]);

    // Asignaciones del docente que coinciden con la sección del estudiante.
    // Admin/auxiliar pueden ver todas las asignaciones de la sección.
    // EXCLUYE Guía y Orientación porque la carta de ausentismo no aplica a esas materias.
    const esAdminAux = ['admin','auxiliar'].includes(u.rol);
    const asigR = await pool.query(`
      SELECT a.id, a.materia_id, a.periodo, m.nombre AS materia, a.lecciones_semana, a.subgrupo,
        u.id AS prof_id, u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2
      FROM asignaciones a
      JOIN materias m ON m.id=a.materia_id
      JOIN usuarios u ON u.id=a.profesor_id
      WHERE a.seccion_id=$1
        AND a.anio=$${esAdminAux ? 2 : 3}
        AND LOWER(m.nombre) NOT LIKE '%guía%'
        AND LOWER(m.nombre) NOT LIKE '%guia%'
        AND LOWER(m.nombre) NOT LIKE '%orientac%'
        ${esAdminAux ? '' : 'AND a.profesor_id=$2'}
      ORDER BY m.nombre`,
      esAdminAux ? [est.seccion_id, anioActivo] : [est.seccion_id, u.id, anioActivo]);

    // Filtrar adicionalmente por subgrupo: si la asignación tiene subgrupo, solo aplica
    // si el estudiante también tiene ese subgrupo (o no tiene asignado).
    // Si la asignación NO tiene subgrupo, aplica a todos los estudiantes de la sección.
    const estSubgrupo = (est.subgrupo || '').trim().toUpperCase();
    const asigsCompatibles = asigR.rows.filter(a => {
      const asigSubgrupo = (a.subgrupo || '').trim().toUpperCase();
      if (!asigSubgrupo) return true;        // Asignación al grupo completo
      if (!estSubgrupo) return true;         // Estudiante sin subgrupo (edge case)
      return asigSubgrupo === estSubgrupo;   // Coinciden
    });
    // Si hubo un intercambio entre períodos pueden existir dos IDs para la
    // misma materia. Elegimos el vigente para mostrar una sola opción; el
    // cálculo inferior suma las sesiones equivalentes de todo el año.
    const porMateria=new Map();
    asigsCompatibles.forEach(a=>{
      const k=`${a.prof_id}-${a.materia_id}-${String(a.subgrupo||'').toUpperCase()}`;
      const anterior=porMateria.get(k);
      if(!anterior || a.periodo===periodoVigente) porMateria.set(k,a);
    });
    const asigsFiltradas=[...porMateria.values()];

    // Para cada asignación filtrada, calcular desde el inicio oficial del
    // curso lectivo hasta la fecha de corte (hoy, o el cierre si ya terminó).
    const asignaciones = [];
    for (const a of asigsFiltradas) {
      const calculo=await calcularAusentismo(a.id,estId,u);
      const totLec = calculo?.total_lecciones || 0;
      const aus    = calculo?.ausencias || 0;
      const pct    = calculo?.porcentaje || 0;
      asignaciones.push({
        asignacion_id: a.id,
        materia: a.materia,
        prof_id: a.prof_id,
        prof_nombre_completo: `${a.prof_nombre} ${a.prof_ap1} ${a.prof_ap2||''}`.replace(/\s+/g,' ').trim(),
        ausencias: aus,
        total_lecciones: totLec,
        porcentaje: pct
      });
    }

    res.json({
      estudiante: est,
      encargado: encR.rows[0] || null,
      asignaciones,
      periodo: p,
      docente: {
        id: u.id,
        nombre_completo: `${u.nombre} ${u.primer_apellido} ${u.segundo_apellido || ''}`.replace(/\s+/g,' ').trim()
      }
    });
  } catch (err) {
    console.error('cartas/datos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ESTUDIANTES QUE EL DOCENTE PUEDE USAR PARA UNA CARTA ─────────────────────
// Devuelve solo los estudiantes que el docente realmente da clase en esa sección,
// respetando subgrupos. Si el docente tiene asignación sin subgrupo (grupo completo),
// devuelve todos. Si tiene subgrupo "B", solo devuelve estudiantes con subgrupo "B" o sin subgrupo.
// EXCLUYE materias de Guía y Orientación (la carta de ausentismo no aplica a esas).
router.get("/estudiantes-disponibles/:seccion_id", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const secId = parseInt(req.params.seccion_id);
  if (!secId) return res.status(400).json({ error: "seccion_id inválido" });
  const esAdminAux = ['admin','auxiliar'].includes(u.rol);
  const anioActivo = await obtenerAnioActivo();

  try {
    // Determinar qué subgrupos puede ver el docente en esa sección,
    // excluyendo materias de Guía y Orientación (case-insensitive).
    let subgrupos = null;  // null = sin restricción de subgrupo
    let tieneAsignacionAplicable = false;

    if (!esAdminAux) {
      const asigR = await pool.query(`
        SELECT a.subgrupo
        FROM asignaciones a
        JOIN materias m ON m.id=a.materia_id
        WHERE a.profesor_id=$1 AND a.seccion_id=$2
          AND a.anio=$3
          AND LOWER(m.nombre) NOT LIKE '%guía%'
          AND LOWER(m.nombre) NOT LIKE '%guia%'
          AND LOWER(m.nombre) NOT LIKE '%orientac%'
      `, [u.id, secId, anioActivo]);

      if (!asigR.rows.length) {
        // No tiene materia aplicable en esa sección
        return res.json([]);
      }
      tieneAsignacionAplicable = true;

      // Si alguna asignación NO tiene subgrupo, el profe ve TODOS los estudiantes
      const tieneGrupoCompleto = asigR.rows.some(r => !r.subgrupo || !r.subgrupo.trim());
      if (!tieneGrupoCompleto) {
        // Recopilar todos los subgrupos donde tiene asignación
        subgrupos = [...new Set(asigR.rows.map(r => r.subgrupo.trim().toUpperCase()))];
      }
    }

    // Construir query de estudiantes
    let sql = `
      SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido, e.subgrupo
      FROM estudiantes e
      WHERE e.seccion_id=$1 AND e.activo=true AND (e.archivado=false OR e.archivado IS NULL)`;
    const params = [secId];

    if (subgrupos && subgrupos.length > 0) {
      // Filtrar por subgrupo: el estudiante debe tener uno de los subgrupos del profe,
      // o NO tener subgrupo asignado (caso edge: estudiante sin clasificar todavía)
      params.push(subgrupos);
      sql += ` AND (UPPER(COALESCE(e.subgrupo,'')) = ANY($${params.length}::text[]) OR COALESCE(e.subgrupo,'') = '')`;
    }

    sql += ` ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre`;
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('cartas/estudiantes-disponibles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SECCIONES DISPONIBLES (helper para el form) ──────────────────────────────
// El profesor regular solo ve secciones donde tiene asignación de materias REGULARES
// (excluye Guía y Orientación). Admin/aux ven todas.
router.get("/secciones-disponibles", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const esAdminAux = ['admin','auxiliar'].includes(u.rol);
  try {
    const anioActivo = await obtenerAnioActivo();
    const r = await pool.query(
      esAdminAux
        ? `SELECT DISTINCT s.id, s.nombre, s.nivel FROM secciones s
           JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=$1 AND sa.activa=true
           ORDER BY s.nivel, s.nombre`
        : `SELECT DISTINCT s.id, s.nombre, s.nivel FROM secciones s
           JOIN asignaciones a ON a.seccion_id=s.id
           JOIN materias m ON m.id=a.materia_id
           WHERE a.profesor_id=$1
             AND a.anio=$2
             AND LOWER(m.nombre) NOT LIKE '%guía%'
             AND LOWER(m.nombre) NOT LIKE '%guia%'
             AND LOWER(m.nombre) NOT LIKE '%orientac%'
           ORDER BY s.nivel, s.nombre`,
      esAdminAux ? [anioActivo] : [u.id,anioActivo]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('cartas/secciones error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GUARDAR carta emitida (registro histórico) ────────────────────────────────
router.post("/", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const { estudiante_id, asignacion_id, materia, ausencias,
          total_lecciones, porcentaje, observaciones } = req.body;
  if (!estudiante_id || !materia)
    return res.status(400).json({ error: "estudiante_id y materia son requeridos" });

  try {
    const p = await rangoCursoHastaHoy();
    const calculo = asignacion_id
      ? await calcularAusentismo(Number(asignacion_id), Number(estudiante_id), u)
      : null;
    if(asignacion_id && !calculo)
      return res.status(403).json({ error:"La asignación o el estudiante no pertenecen al docente." });
    const materiaFinal = calculo?.asignacion.materia || materia;
    const ausenciasFinal = calculo?.ausencias ?? (parseInt(ausencias)||0);
    const totalFinal = calculo?.total_lecciones ?? (parseInt(total_lecciones)||0);
    const porcentajeFinal = calculo?.porcentaje ?? (parseFloat(porcentaje)||0);
    const r = await pool.query(`
      INSERT INTO cartas_ausentismo
        (estudiante_id, asignacion_id, emitida_por, fecha, periodo, materia,
         ausencias, total_lecciones, porcentaje, observaciones)
      VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,$9)
      RETURNING id, fecha
    `, [estudiante_id, asignacion_id || null, u.id, p.nombre, materiaFinal,
        ausenciasFinal, totalFinal, porcentajeFinal, observaciones || '']);
    res.json({ ok: true, id: r.rows[0].id, fecha: r.rows[0].fecha });
  } catch (err) {
    console.error('cartas POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CONTROL SIN DERECHO A CONVOCATORIA POR AUSENTISMO ────────────────────
router.get("/convocatoria/candidatos", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const anio = await obtenerAnioActivo();
  const rango=await rangoCursoHastaHoy(anio);
  const r = await pool.query(`
    WITH base AS (
      SELECT a.*,ROW_NUMBER() OVER(
        PARTITION BY a.profesor_id,a.seccion_id,a.materia_id,COALESCE(a.subgrupo,'')
        ORDER BY CASE WHEN COALESCE(a.periodo,'I Período')=$5 THEN 0 ELSE 1 END,a.id DESC
      ) AS rn
      FROM asignaciones a
      WHERE a.profesor_id=$1 AND a.anio=$2 AND COALESCE(a.activa,true)=true
    )
    SELECT a.id AS asignacion_id,e.id AS estudiante_id,m.nombre AS materia,
      s.nombre AS seccion_nombre,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,
      COALESCE(st.total_lecciones,0)::int AS total_lecciones,
      COALESCE(st.ausencias,0)::int AS ausencias
    FROM base a
    JOIN materias m ON m.id=a.materia_id
    JOIN secciones s ON s.id=a.seccion_id
    JOIN secciones_anio san ON san.seccion_id=a.seccion_id AND san.anio=$2 AND san.activa=true
    JOIN estudiantes e ON e.seccion_id=a.seccion_id
      AND e.activo=true AND COALESCE(e.archivado,false)=false
      AND (COALESCE(a.subgrupo,'')='' OR COALESCE(UPPER(e.subgrupo),'') IN (UPPER(a.subgrupo),''))
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(sa.lecciones),0)::int AS total_lecciones,
        COALESCE(SUM(COALESCE(ast.lecciones_ausentes,sa.lecciones))
          FILTER (WHERE ast.estado='A' AND NOT ast.justificada),0)::int AS ausencias
      FROM sesiones_asistencia sa
      LEFT JOIN asistencia ast ON ast.sesion_id=sa.id AND ast.estudiante_id=e.id
      JOIN asignaciones ax ON ax.id=sa.asignacion_id
      WHERE ax.anio=$2 AND ax.profesor_id=a.profesor_id AND ax.seccion_id=a.seccion_id
        AND ax.materia_id=a.materia_id AND COALESCE(ax.subgrupo,'')=COALESCE(a.subgrupo,'')
        AND sa.fecha BETWEEN $3 AND $4
    ) st ON true
    WHERE a.rn=1
      AND LOWER(m.nombre) NOT LIKE '%guía%' AND LOWER(m.nombre) NOT LIKE '%guia%'
      AND LOWER(m.nombre) NOT LIKE '%orientac%'
      AND COALESCE(st.total_lecciones,0)>0
    ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre,s.nivel,s.nombre,m.nombre
  `, [u.id,anio,rango.desde,rango.hasta,(await periodoActual()).nombre]);
  const salida=r.rows.map(x=>{
    const porcentaje=x.total_lecciones
      ? Math.round((Number(x.ausencias)/Number(x.total_lecciones))*10000)/100 : 0;
    return {...x,porcentaje,fecha_desde:rango.desde,fecha_hasta:rango.hasta,
      sin_derecho:porcentaje>20};
  });
  res.json(salida);
});

router.get("/convocatoria/registros", requireDocente, async (req, res) => {
  const u=req.session.usuario;
  const anio=await obtenerAnioActivo();
  const admin=u.rol==='admin';
  const r=await pool.query(`
    SELECT ca.*,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,
      u.nombre AS prof_nombre,u.primer_apellido AS prof_ap1,u.segundo_apellido AS prof_ap2
    FROM convocatoria_ausentismo ca
    JOIN estudiantes e ON e.id=ca.estudiante_id
    JOIN usuarios u ON u.id=ca.profesor_id
    WHERE ca.anio=$1 AND ca.activa=true ${admin?'':'AND ca.profesor_id=$2'}
    ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre,ca.materia
  `,admin?[anio]:[anio,u.id]);
  res.json(r.rows);
});

router.post("/convocatoria/marcar", requireDocente, async (req,res)=>{
  const u=req.session.usuario;
  const asignacionId=Number(req.body.asignacion_id);
  const estudianteId=Number(req.body.estudiante_id);
  const calculo=await calcularAusentismo(asignacionId,estudianteId,u);
  if(!calculo) return res.status(403).json({error:"El estudiante no pertenece a esa asignatura del docente."});
  if(!calculo.estudiante.activo || calculo.estudiante.archivado)
    return res.status(409).json({error:"Solo se puede marcar a estudiantes activos."});
  if(calculo.total_lecciones<=0)
    return res.status(409).json({error:"Todavía no hay lecciones impartidas para calcular el porcentaje."});
  if(calculo.porcentaje<=20)
    return res.status(409).json({error:`El estudiante registra ${calculo.porcentaje}% de ausentismo; conserva al menos el 80% de asistencia.`});
  const a=calculo.asignacion;
  const obs=String(req.body.observaciones||'').trim().slice(0,500);
  const r=await pool.query(`
    INSERT INTO convocatoria_ausentismo
      (anio,estudiante_id,asignacion_id,profesor_id,materia,seccion,ausencias,total_lecciones,
       porcentaje,fecha_desde,fecha_hasta,fundamento,observaciones,activa)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
    ON CONFLICT (anio,estudiante_id,asignacion_id,profesor_id) DO UPDATE SET
      materia=EXCLUDED.materia,seccion=EXCLUDED.seccion,ausencias=EXCLUDED.ausencias,
      total_lecciones=EXCLUDED.total_lecciones,porcentaje=EXCLUDED.porcentaje,
      fecha_desde=EXCLUDED.fecha_desde,fecha_hasta=EXCLUDED.fecha_hasta,
      fundamento=EXCLUDED.fundamento,observaciones=EXCLUDED.observaciones,
      activa=true,actualizada_at=NOW()
    RETURNING id
  `,[calculo.rango.anio,estudianteId,asignacionId,a.profesor_id,a.materia,a.seccion_nombre,
     calculo.ausencias,calculo.total_lecciones,calculo.porcentaje,calculo.rango.desde,
     calculo.rango.hasta,FUNDAMENTO_CONVOCATORIA,obs]);
  res.json({ok:true,id:r.rows[0].id,porcentaje:calculo.porcentaje});
});

router.delete("/convocatoria/:id", requireDocente, async(req,res)=>{
  const u=req.session.usuario;
  const admin=u.rol==='admin';
  const r=await pool.query(`UPDATE convocatoria_ausentismo SET activa=false,actualizada_at=NOW()
    WHERE id=$1 AND activa=true ${admin?'':'AND profesor_id=$2'} RETURNING id`,
    admin?[req.params.id]:[req.params.id,u.id]);
  if(!r.rows.length) return res.status(404).json({error:"Registro no encontrado."});
  res.json({ok:true});
});

// ── LISTAR cartas emitidas (admin/aux ven todas, otros solo las suyas) ────────
router.get("/", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const esAdminAux = ['admin','auxiliar'].includes(u.rol);
  try {
    const r = await pool.query(`
      SELECT c.id, c.fecha, c.periodo, c.materia, c.ausencias, c.total_lecciones, c.porcentaje,
        e.id AS estudiante_id, e.nombre AS est_nombre,
        e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
        s.nombre AS seccion_nombre,
        u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
      FROM cartas_ausentismo c
      JOIN estudiantes e ON e.id=c.estudiante_id
      LEFT JOIN secciones s ON s.id=e.seccion_id
      JOIN usuarios u ON u.id=c.emitida_por
      ${esAdminAux ? '' : 'WHERE c.emitida_por=$1'}
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 200
    `, esAdminAux ? [] : [u.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('cartas GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── OBTENER una carta específica (para reimprimir desde el histórico) ─────────
router.get("/:id", requireDocente, async (req, res) => {
  const u = req.session.usuario;
  const esAdminAux = ['admin','auxiliar'].includes(u.rol);
  try {
    const r = await pool.query(`
      SELECT c.*,
        e.id AS estudiante_id, e.cedula AS est_cedula, e.nombre AS est_nombre,
        e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
        s.nombre AS seccion_nombre,
        u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.segundo_apellido AS prof_ap2,
        enc.nombre AS enc_nombre, enc.primer_apellido AS enc_ap1, enc.segundo_apellido AS enc_ap2,
        enc.cedula AS enc_cedula, enc.parentesco AS enc_parentesco
      FROM cartas_ausentismo c
      JOIN estudiantes e ON e.id=c.estudiante_id
      LEFT JOIN secciones s ON s.id=e.seccion_id
      JOIN usuarios u ON u.id=c.emitida_por
      LEFT JOIN LATERAL (
        SELECT nombre, primer_apellido, segundo_apellido, cedula, parentesco
        FROM encargados WHERE estudiante_id=e.id
        ORDER BY es_principal DESC, id ASC LIMIT 1
      ) enc ON true
      WHERE c.id=$1 ${esAdminAux ? '' : 'AND c.emitida_por=$2'}
    `, esAdminAux ? [req.params.id] : [req.params.id, u.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Carta no encontrada" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('cartas GET id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

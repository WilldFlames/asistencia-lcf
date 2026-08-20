const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { obtenerAnioActivo, obtenerRangoPeriodo } = require("../utils/lectivo");

// Año actual en zona horaria de Costa Rica (UTC-6)
// ── Política de acceso del módulo de Calificaciones ────────────────────
// SOLO el profesor que enseña una asignación puede ver/manipular sus notas.
// Ni admin, ni guía, ni orientador, ni auxiliar tienen acceso.

// ── LISTAR mis asignaciones con la regla oficial REAC ──────────────────
// Para cada asignación del profesor logueado, devuelve la regla oficial
// que aplica según la materia y el nivel de la sección.
router.get("/mis-asignaciones", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const periodo = req.query.periodo || "I Período";

  try {
    const r = await pool.query(`
      SELECT
        a.id              AS asignacion_id,
        a.profesor_id,
        a.seccion_id,
        s.nombre          AS seccion_nombre,
        s.nivel           AS seccion_nivel,
        a.materia_id,
        m.nombre          AS materia_nombre,
        -- "simplificado" si: (a) la materia entera está marcada, O (b) la
        -- asignación específica está marcada Y el periodo actual está
        -- listado en simplificado_periodos.
        (
          COALESCE(m.modo_simplificado, false)
          OR (
            COALESCE(a.modo_simplificado, false)
            AND COALESCE(a.periodo, 'I Período') = ANY(COALESCE(a.simplificado_periodos, ARRAY[]::TEXT[]))
          )
        ) AS modo_simplificado,
        a.modo_simplificado AS asig_modo_simplificado,
        COALESCE(a.simplificado_periodos, ARRAY[]::TEXT[]) AS simplificado_periodos,
        COALESCE(m.modo_simplificado, false) AS materia_modo_simplificado,
        a.subgrupo,
        a.periodo         AS asig_periodo,
        regla.id           AS regla_id,
        regla.codigo       AS regla_codigo,
        regla.descripcion  AS regla_descripcion,
        regla.porc_cotidiano,
        regla.porc_tareas,
        regla.porc_pruebas,
        regla.porc_proyectos,
        regla.porc_asistencia,
        regla.cantidad_pruebas,
        regla.cantidad_proyectos,
        regla.proyecto_o_prueba,
        regla.notas         AS regla_notas
      FROM asignaciones a
      JOIN secciones s ON s.id = a.seccion_id
      JOIN materias m  ON m.id = a.materia_id
      LEFT JOIN materia_regla_evaluacion mre
        ON mre.materia_id = a.materia_id
        AND s.nivel BETWEEN mre.nivel_min AND mre.nivel_max
      LEFT JOIN materia_evaluacion_oficial regla
        ON regla.id = mre.regla_id
      WHERE a.profesor_id = $1
        AND COALESCE(a.anio, $3) = $3
        -- Mostrar asignaciones del período pedido O las del I Período que
        -- NO tienen una versión más nueva en el II Período (herencia
        -- automática — la mayoría de materias son anuales y no cambian
        -- entre períodos, solo algunas como los talleres rotan).
        AND (
          a.periodo = $2
          OR (
            COALESCE(a.periodo,'I Período') = 'I Período'
            AND NOT EXISTS (
              SELECT 1 FROM asignaciones a2
              WHERE a2.profesor_id = a.profesor_id
                AND a2.seccion_id = a.seccion_id
                AND a2.materia_id = a.materia_id
                AND COALESCE(a2.subgrupo,'') = COALESCE(a.subgrupo,'')
                AND a2.periodo = $2
                AND COALESCE(a2.anio, $3) = $3
            )
          )
        )
        AND m.nombre NOT IN ('Guía','Orientación','Fortalecimiento Matemático')
      ORDER BY s.nombre, m.nombre, a.subgrupo NULLS FIRST
    `, [u.id, periodo, await obtenerAnioActivo()]);

    res.json(r.rows);
  } catch (e) {
    console.error("calificaciones/mis-asignaciones:", e);
    res.status(500).json({ error: "Error al cargar asignaciones." });
  }
});

// ── CATÁLOGO completo de reglas REAC (informativo) ─────────────────────
// Útil para mostrar la tabla maestra al profesor como referencia.
router.get("/reglas", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, codigo, descripcion, nivel_min, nivel_max,
             porc_cotidiano, porc_tareas, porc_pruebas, porc_proyectos, porc_asistencia,
             cantidad_pruebas, cantidad_proyectos, proyecto_o_prueba, notas
      FROM materia_evaluacion_oficial
      ORDER BY nivel_min, codigo
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: "Error al cargar reglas." });
  }
});

// ════════════════════════════════════════════════════════════════════════
// FASE 2: EVALUACIONES (exámenes, tareas, cotidianos, proyectos)
// ════════════════════════════════════════════════════════════════════════
//
// Política: solo el profesor dueño de la evaluación puede leer/crear/modificar/
// eliminar. Se valida CADA vez que (asignacion existe Y profesor_id = sesión).

// Helper: verifica que el profesor tenga una asignación válida con esos
// identificadores (seccion, materia, subgrupo, periodo). Devuelve la asignación
// o null si no existe.
async function verificarAsignacion(profesor_id, seccion_id, materia_id, subgrupo, periodo) {
  // Buscar la asignación con lógica de herencia:
  //   1º intento: asignación creada específicamente para el período pedido
  //   2º intento: asignación del I Período (que hereda automáticamente al II
  //               cuando no existe una versión específica del II)
  // Prioriza siempre la más específica (por eso el ORDER BY).
  const r = await pool.query(`
    SELECT a.id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo,
           m.nombre AS materia_nombre, s.nombre AS seccion_nombre,
           (a.modo_simplificado OR COALESCE(m.modo_simplificado, false)) AS modo_simplificado,
           s.nivel AS seccion_nivel,
           COALESCE(a.periodo,'I Período') AS periodo,
           mre.regla_id, reg.codigo AS regla_codigo, reg.cantidad_pruebas, reg.cantidad_proyectos, reg.proyecto_o_prueba
    FROM asignaciones a
    JOIN materias m ON m.id = a.materia_id
    JOIN secciones s ON s.id = a.seccion_id
    LEFT JOIN materia_regla_evaluacion mre
      ON mre.materia_id = a.materia_id
      AND s.nivel BETWEEN mre.nivel_min AND mre.nivel_max
    LEFT JOIN materia_evaluacion_oficial reg ON reg.id = mre.regla_id
    WHERE a.profesor_id = $1
      AND a.seccion_id  = $2
      AND a.materia_id  = $3
      AND a.anio = $6
      AND (($4::text IS NULL AND a.subgrupo IS NULL) OR a.subgrupo = $4)
      AND (
        COALESCE(a.periodo,'I Período') = $5
        OR (
          COALESCE(a.periodo,'I Período') = 'I Período'
          AND NOT EXISTS (
            SELECT 1 FROM asignaciones a2
            WHERE a2.profesor_id = a.profesor_id
              AND a2.seccion_id = a.seccion_id
              AND a2.materia_id = a.materia_id
              AND (($4::text IS NULL AND a2.subgrupo IS NULL) OR a2.subgrupo = $4)
              AND COALESCE(a2.periodo,'I Período') = $5
              AND a2.anio = $6
          )
        )
      )
    ORDER BY CASE WHEN COALESCE(a.periodo,'I Período')=$5 THEN 0 ELSE 1 END
    LIMIT 1
  `, [profesor_id, seccion_id, materia_id, subgrupo || null, periodo, await obtenerAnioActivo()]);
  return r.rows[0] || null;
}

// Helper: verifica que la evaluación exista Y pertenezca al usuario logueado.
async function getEvaluacionMia(u, evaluacion_id) {
  const r = await pool.query("SELECT * FROM evaluaciones WHERE id=$1", [evaluacion_id]);
  if (!r.rows.length) return { err: 404, msg: "Evaluación no encontrada." };
  if (Number(r.rows[0].profesor_id) !== Number(u.id)) {
    return { err: 403, msg: "Esta evaluación no te pertenece." };
  }
  return { row: r.rows[0] };
}

// ── LISTAR evaluaciones de una asignación ──────────────────────────────
router.get("/evaluaciones", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { seccion_id, materia_id, subgrupo, periodo } = req.query;
  if (!seccion_id || !materia_id || !periodo) {
    return res.status(400).json({ error: "Faltan parámetros." });
  }
  const asig = await verificarAsignacion(u.id, seccion_id, materia_id, subgrupo, periodo);
  if (!asig) return res.status(403).json({ error: "Sin acceso a esta asignación." });

  try {
    const r = await pool.query(`
      SELECT e.*,
        (SELECT COUNT(*) FROM indicadores i WHERE i.evaluacion_id = e.id) AS cant_indicadores,
        CASE
          WHEN e.tipo='examen' THEN (SELECT COUNT(*) FROM notas_examen nx WHERE nx.evaluacion_id=e.id AND nx.puntos_obtenidos IS NOT NULL)
          ELSE (SELECT COUNT(DISTINCT ni.estudiante_id) FROM notas_indicador ni WHERE ni.evaluacion_id=e.id AND ni.puntaje IS NOT NULL)
        END AS cant_calificados,
        (SELECT COUNT(*) FROM estudiantes est
          WHERE est.seccion_id = e.seccion_id
            AND est.activo = true
            AND (
              e.subgrupo IS NULL
              OR est.subgrupo = e.subgrupo
            )
        ) AS cant_estudiantes
      FROM evaluaciones e
      WHERE e.profesor_id = $1
        AND e.seccion_id  = $2
        AND e.materia_id  = $3
        AND (($4::text IS NULL AND e.subgrupo IS NULL) OR e.subgrupo = $4)
        AND e.periodo     = $5
      ORDER BY e.tipo, e.fecha, e.id
    `, [u.id, seccion_id, materia_id, subgrupo || null, periodo]);
    // Incluir estado de cierre para que el frontend deshabilite acciones
    const cierre = await getEstadoPeriodo(u.id, seccion_id, materia_id, subgrupo, periodo);
    res.json({ asignacion: asig, evaluaciones: r.rows, cierre });
  } catch (e) {
    console.error("evaluaciones GET:", e);
    res.status(500).json({ error: "Error al cargar evaluaciones." });
  }
});

// Cuadro individual, de solo lectura, para Trabajo cotidiano o Tareas.
// Sin estudiante_id devuelve únicamente la lista de estudiantes disponible
// para el selector; con estudiante_id incluye el detalle derivado de notas.
router.get("/resumen-rubro", requireAuth, async (req,res)=>{
  const u=req.session.usuario;
  const {seccion_id,materia_id,subgrupo,periodo}=req.query;
  const tipo=String(req.query.tipo||"");
  const estudianteId=Number(req.query.estudiante_id)||null;
  if(!seccion_id||!materia_id||!periodo||!["cotidiano","tarea"].includes(tipo))
    return res.status(400).json({error:"Faltan datos para generar el resumen."});
  const asig=await verificarAsignacion(u.id,seccion_id,materia_id,subgrupo,periodo);
  if(!asig) return res.status(403).json({error:"Sin acceso a esta asignación."});
  const estudiantes=await pool.query(`SELECT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido
    FROM estudiantes e WHERE e.seccion_id=$1 AND e.activo=true AND COALESCE(e.archivado,false)=false
      AND ($2::text IS NULL OR e.subgrupo=$2)
    ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre`,[seccion_id,subgrupo||null]);
  if(!estudianteId) return res.json({asignacion:asig,estudiantes:estudiantes.rows,tipo,evaluaciones:[]});
  const estudiante=estudiantes.rows.find(e=>Number(e.id)===estudianteId);
  if(!estudiante) return res.status(403).json({error:"El estudiante no pertenece a esta asignación."});
  const evaluaciones=await pool.query(`SELECT id,nombre,descripcion,fecha,fecha_asignacion,puntaje_total
    FROM evaluaciones WHERE profesor_id=$1 AND seccion_id=$2 AND materia_id=$3
      AND ($4::text IS NULL AND subgrupo IS NULL OR subgrupo=$4)
      AND periodo=$5 AND tipo=$6 ORDER BY fecha,id`,
    [u.id,seccion_id,materia_id,subgrupo||null,periodo,tipo]);
  const ids=evaluaciones.rows.map(e=>e.id);
  let indicadores=[],notas=[];
  if(ids.length){
    indicadores=(await pool.query(`SELECT id,evaluacion_id,orden,descripcion,puntaje_maximo
      FROM indicadores WHERE evaluacion_id=ANY($1::int[]) ORDER BY evaluacion_id,orden`,[ids])).rows;
    notas=(await pool.query(`SELECT evaluacion_id,indicador_id,puntaje FROM notas_indicador
      WHERE evaluacion_id=ANY($1::int[]) AND estudiante_id=$2`,[ids,estudianteId])).rows;
  }
  const notaMap=new Map(notas.map(n=>[`${n.evaluacion_id}:${n.indicador_id}`,n.puntaje]));
  const detalle=evaluaciones.rows.map(ev=>{
    const inds=indicadores.filter(i=>Number(i.evaluacion_id)===Number(ev.id)).map(i=>({
      id:i.id,orden:i.orden,descripcion:i.descripcion,puntaje_maximo:Number(i.puntaje_maximo),
      puntaje:notaMap.has(`${ev.id}:${i.id}`)?Number(notaMap.get(`${ev.id}:${i.id}`)):null
    }));
    const calificadas=inds.filter(i=>i.puntaje!==null);
    return {...ev,puntaje_total:Number(ev.puntaje_total||inds.reduce((s,i)=>s+i.puntaje_maximo,0)),
      puntos_obtenidos:calificadas.length?calificadas.reduce((s,i)=>s+i.puntaje,0):null,
      indicadores:inds};
  });
  res.json({asignacion:asig,estudiante,estudiantes:estudiantes.rows,tipo,evaluaciones:detalle});
});

// ── CREAR evaluación ────────────────────────────────────────────────────
// Body para examen:        { tipo:'examen', nombre, descripcion?, fecha, puntaje_total, seccion_id, materia_id, subgrupo?, periodo }
// Body para tarea:         { tipo:'tarea', nombre, descripcion?, fecha_asignacion, fecha (entrega), seccion_id, materia_id, subgrupo?, periodo, indicadores: [...] }
// Body para cotid/proy:    { tipo:'cotidiano'|'proyecto', nombre, descripcion?, fecha, seccion_id, materia_id, subgrupo?, periodo, indicadores: [...] }
router.post("/evaluaciones", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { tipo, nombre, descripcion, fecha, fecha_asignacion, puntaje_total, valor_porcentual, indicadores,
          seccion_id, materia_id, subgrupo, periodo } = req.body;

  // Validaciones de campos básicos
  if (!tipo || !nombre || !fecha) return res.status(400).json({ error: "Faltan campos obligatorios." });
  if (!['examen','tarea','cotidiano','proyecto'].includes(tipo)) return res.status(400).json({ error: "Tipo inválido." });
  if (!seccion_id || !materia_id || !periodo) return res.status(400).json({ error: "Faltan datos de asignación." });

  // Tareas y proyectos llevan fecha de asignación (el profe los entrega con
  // anticipación). Cotidianos y exámenes no — son del día.
  // La fecha de entrega puede ser anterior a la de asignación si así lo decide
  // el profesor (no validamos el orden).
  if (tipo === 'tarea' || tipo === 'proyecto') {
    if (!fecha_asignacion) {
      return res.status(400).json({ error: `Para ${tipo === 'tarea' ? 'una tarea' : 'un proyecto'} hay que indicar la fecha de asignación.` });
    }
  }

  // Verificar asignación
  const asig = await verificarAsignacion(u.id, seccion_id, materia_id, subgrupo, periodo);
  if (!asig) return res.status(403).json({ error: "Sin acceso a esta asignación." });

  // Si el período está cerrado, no se permiten cambios
  const cierre = await getEstadoPeriodo(u.id, seccion_id, materia_id, subgrupo, periodo);
  if (cierre.cerrado) {
    return res.status(423).json({ error: "El período está cerrado. Pedile al administrador que lo reabra para hacer cambios." });
  }

  // Validaciones específicas por tipo
  if (tipo === 'examen') {
    if (!puntaje_total || Number(puntaje_total) <= 0) {
      return res.status(400).json({ error: "El puntaje total del examen debe ser mayor a 0." });
    }
    // El valor porcentual es OBLIGATORIO en exámenes
    const vp = Number(valor_porcentual);
    if (!vp || vp <= 0 || vp > 100) {
      return res.status(400).json({ error: "Indicá el valor porcentual de este examen (entre 0 y 100)." });
    }
    // BLOQUEO: la suma de porcentajes de los exámenes no puede pasar el % de pruebas de la materia
    const pesoPruebas = Number(asig.porc_pruebas || 0);
    if (pesoPruebas > 0) {
      const yaUsado = await pool.query(
        "SELECT COALESCE(SUM(valor_porcentual),0)::numeric AS suma FROM evaluaciones WHERE profesor_id=$1 AND seccion_id=$2 AND materia_id=$3 AND (($4::text IS NULL AND subgrupo IS NULL) OR subgrupo=$4) AND periodo=$5 AND tipo='examen'",
        [u.id, seccion_id, materia_id, subgrupo || null, periodo]
      );
      const sumaActual = Number(yaUsado.rows[0].suma);
      const sumaConNuevo = sumaActual + vp;
      if (sumaConNuevo > pesoPruebas + 0.01) { // 0.01 de tolerancia por redondeo
        const disponible = (pesoPruebas - sumaActual).toFixed(2);
        return res.status(400).json({
          error: `No alcanza el porcentaje disponible. En esta materia las pruebas valen ${pesoPruebas}% y ya hay exámenes que suman ${sumaActual}%. Para este examen quedan disponibles ${disponible}% (vos pediste ${vp}%).`
        });
      }
    }
  } else {
    // tarea/cotidiano/proyecto necesitan al menos 1 indicador
    if (!Array.isArray(indicadores) || !indicadores.length) {
      return res.status(400).json({ error: "Debés agregar al menos un indicador." });
    }
    for (const ind of indicadores) {
      if (!ind.descripcion || !String(ind.descripcion).trim()) {
        return res.status(400).json({ error: "Todos los indicadores deben tener descripción." });
      }
      const pm = Number(ind.puntaje_maximo);
      if (!Number.isInteger(pm) || pm <= 0) {
        return res.status(400).json({ error: "El puntaje máximo de cada indicador debe ser entero mayor a 0." });
      }
    }
  }

  // Aviso (no bloqueante) si excede la cantidad sugerida por REAC
  let aviso = null;
  if (asig.regla_id) {
    if (tipo === 'examen' && asig.cantidad_pruebas > 0) {
      const c = await pool.query(
        "SELECT COUNT(*)::int AS n FROM evaluaciones WHERE profesor_id=$1 AND seccion_id=$2 AND materia_id=$3 AND (($4::text IS NULL AND subgrupo IS NULL) OR subgrupo=$4) AND periodo=$5 AND tipo='examen'",
        [u.id, seccion_id, materia_id, subgrupo || null, periodo]
      );
      if (c.rows[0].n >= asig.cantidad_pruebas) {
        aviso = `El REAC indica ${asig.cantidad_pruebas} prueba${asig.cantidad_pruebas>1?'s':''} para esta materia. Esta sería la #${c.rows[0].n + 1}.`;
      }
    }
    if (tipo === 'proyecto' && asig.cantidad_proyectos > 0) {
      const c = await pool.query(
        "SELECT COUNT(*)::int AS n FROM evaluaciones WHERE profesor_id=$1 AND seccion_id=$2 AND materia_id=$3 AND (($4::text IS NULL AND subgrupo IS NULL) OR subgrupo=$4) AND periodo=$5 AND tipo='proyecto'",
        [u.id, seccion_id, materia_id, subgrupo || null, periodo]
      );
      if (c.rows[0].n >= asig.cantidad_proyectos) {
        aviso = `El REAC indica ${asig.cantidad_proyectos} proyecto${asig.cantidad_proyectos>1?'s':''} para esta materia. Este sería el #${c.rows[0].n + 1}.`;
      }
    }
  }

  // Transacción: insertar evaluación + indicadores
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pt = tipo === 'examen'
      ? Number(puntaje_total)
      : indicadores.reduce((s, i) => s + Number(i.puntaje_maximo), 0);
    const vp = tipo === 'examen' ? Number(valor_porcentual) : null;
    const ev = await client.query(`
      INSERT INTO evaluaciones (profesor_id, seccion_id, materia_id, subgrupo, periodo, tipo, nombre, descripcion, fecha, fecha_asignacion, puntaje_total, valor_porcentual)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [u.id, seccion_id, materia_id, subgrupo || null, periodo, tipo, nombre.trim(), descripcion || null, fecha, ((tipo === 'tarea' || tipo === 'proyecto') ? fecha_asignacion : null), pt, vp]);
    const evaluacion = ev.rows[0];

    if (tipo !== 'examen') {
      for (let i = 0; i < indicadores.length; i++) {
        await client.query(`
          INSERT INTO indicadores (evaluacion_id, orden, descripcion, puntaje_maximo)
          VALUES ($1, $2, $3, $4)
        `, [evaluacion.id, i + 1, indicadores[i].descripcion.trim(), Number(indicadores[i].puntaje_maximo)]);
      }
    }

    await client.query("COMMIT");
    res.json({ evaluacion, aviso });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("evaluaciones POST:", e);
    res.status(500).json({ error: "Error al crear la evaluación." });
  } finally {
    client.release();
  }
});

// ── OBTENER una evaluación con sus indicadores ─────────────────────────
router.get("/evaluaciones/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { row, err, msg } = await getEvaluacionMia(u, req.params.id);
  if (err) return res.status(err).json({ error: msg });
  const inds = await pool.query("SELECT * FROM indicadores WHERE evaluacion_id=$1 ORDER BY orden", [row.id]);
  res.json({ evaluacion: row, indicadores: inds.rows });
});

// ── EDITAR evaluación (metadatos solamente, NO los indicadores) ────────
// Para cambiar indicadores hay que crear una nueva evaluación.
// Esto evita que editar indicadores rompa notas ya existentes.
router.put("/evaluaciones/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { row, err, msg } = await getEvaluacionMia(u, req.params.id);
  if (err) return res.status(err).json({ error: msg });
  // Bloquear si período cerrado
  const cierre = await getEstadoPeriodo(u.id, row.seccion_id, row.materia_id, row.subgrupo, row.periodo);
  if (cierre.cerrado) return res.status(423).json({ error: "El período está cerrado. Pedile al admin que lo reabra para hacer cambios." });
  const { nombre, descripcion, fecha, fecha_asignacion, puntaje_total, valor_porcentual } = req.body;
  if (!nombre || !fecha) return res.status(400).json({ error: "Faltan campos." });
  if (row.tipo === 'examen' && (!puntaje_total || Number(puntaje_total) <= 0)) {
    return res.status(400).json({ error: "El puntaje total debe ser mayor a 0." });
  }
  // Si es examen, también validar valor porcentual y que no rompa la suma total
  if (row.tipo === 'examen') {
    const vp = Number(valor_porcentual);
    if (!vp || vp <= 0 || vp > 100) {
      return res.status(400).json({ error: "Indicá el valor porcentual de este examen (entre 0 y 100)." });
    }
    // Buscar la regla REAC para validar la suma
    const asig = await verificarAsignacion(u.id, row.seccion_id, row.materia_id, row.subgrupo, row.periodo);
    const pesoPruebas = Number(asig?.porc_pruebas || 0);
    if (pesoPruebas > 0) {
      const yaUsado = await pool.query(
        "SELECT COALESCE(SUM(valor_porcentual),0)::numeric AS suma FROM evaluaciones WHERE profesor_id=$1 AND seccion_id=$2 AND materia_id=$3 AND (($4::text IS NULL AND subgrupo IS NULL) OR subgrupo=$4) AND periodo=$5 AND tipo='examen' AND id<>$6",
        [u.id, row.seccion_id, row.materia_id, row.subgrupo || null, row.periodo, row.id]
      );
      const sumaOtros = Number(yaUsado.rows[0].suma);
      if (sumaOtros + vp > pesoPruebas + 0.01) {
        const disponible = (pesoPruebas - sumaOtros).toFixed(2);
        return res.status(400).json({
          error: `No alcanza el porcentaje disponible. En esta materia las pruebas valen ${pesoPruebas}% y los otros exámenes suman ${sumaOtros}%. Para este examen quedan disponibles ${disponible}% (vos pediste ${vp}%).`
        });
      }
    }
  }
  if (row.tipo === 'tarea' || row.tipo === 'proyecto') {
    if (!fecha_asignacion) return res.status(400).json({ error: "Falta la fecha de asignación." });
  }
  // Si cambia el puntaje del examen, las notas siguen siendo válidas
  // (puntos_obtenidos no cambia, solo se reinterpreta la proporción).
  const newPt = row.tipo === 'examen' ? Number(puntaje_total) : row.puntaje_total;
  const newVp = row.tipo === 'examen' ? Number(valor_porcentual) : null;
  const newFAsig = (row.tipo === 'tarea' || row.tipo === 'proyecto') ? fecha_asignacion : null;
  await pool.query(`
    UPDATE evaluaciones SET nombre=$1, descripcion=$2, fecha=$3, fecha_asignacion=$4, puntaje_total=$5, valor_porcentual=$6, updated_at=NOW()
    WHERE id=$7
  `, [nombre.trim(), descripcion || null, fecha, newFAsig, newPt, newVp, row.id]);
  res.json({ ok: true });
});

// ── ELIMINAR evaluación (cascada: indicadores y notas se borran) ───────
router.delete("/evaluaciones/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { row, err, msg } = await getEvaluacionMia(u, req.params.id);
  if (err) return res.status(err).json({ error: msg });
  const cierre = await getEstadoPeriodo(u.id, row.seccion_id, row.materia_id, row.subgrupo, row.periodo);
  if (cierre.cerrado) return res.status(423).json({ error: "El período está cerrado. Pedile al admin que lo reabra para hacer cambios." });
  await pool.query("DELETE FROM evaluaciones WHERE id=$1", [row.id]);
  res.json({ ok: true });
});

// ── OBTENER notas de una evaluación (para la grilla de calificación) ───
router.get("/evaluaciones/:id/notas", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { row: ev, err, msg } = await getEvaluacionMia(u, req.params.id);
  if (err) return res.status(err).json({ error: msg });

  // Estudiantes de la sección (activos), filtrando por subgrupo si aplica.
  // Si la evaluación tiene subgrupo, SOLO estudiantes con ese subgrupo exacto.
  // Si la evaluación no tiene subgrupo (toda la sección), todos los activos.
  const estudiantes = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido, e.subgrupo,
      COALESCE(ad.no_significativa,false) AS adecuacion_no_significativa,
      COALESCE(ad.significativa,false) AS adecuacion_significativa,
      COALESCE(ad.acceso,false) AS adecuacion_acceso,
      COALESCE(ad.observacion,'') AS adecuacion_observacion
    FROM estudiantes e
    LEFT JOIN adecuaciones_estudiante ad ON ad.estudiante_id=e.id
    WHERE e.seccion_id = $1 AND e.activo = true
      AND (($2::text IS NULL) OR e.subgrupo = $2)
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
  `, [ev.seccion_id, ev.subgrupo || null]);

  let notas = [];
  let indicadores = [];
  if (ev.tipo === 'examen') {
    const r = await pool.query("SELECT estudiante_id, puntos_obtenidos FROM notas_examen WHERE evaluacion_id=$1", [ev.id]);
    notas = r.rows;
  } else {
    const i = await pool.query("SELECT * FROM indicadores WHERE evaluacion_id=$1 ORDER BY orden", [ev.id]);
    indicadores = i.rows;
    const r = await pool.query("SELECT estudiante_id, indicador_id, puntaje FROM notas_indicador WHERE evaluacion_id=$1", [ev.id]);
    notas = r.rows;
  }
  res.json({ evaluacion: ev, estudiantes: estudiantes.rows, indicadores, notas });
});

// ── GUARDAR notas de una evaluación ────────────────────────────────────
// Body para examen:  { notas: [{estudiante_id, puntos_obtenidos}, ...] }
// Body para los otros: { notas: [{estudiante_id, indicador_id, puntaje}, ...] }
router.put("/evaluaciones/:id/notas", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { row: ev, err, msg } = await getEvaluacionMia(u, req.params.id);
  if (err) return res.status(err).json({ error: msg });
  const cierre = await getEstadoPeriodo(u.id, ev.seccion_id, ev.materia_id, ev.subgrupo, ev.periodo);
  if (cierre.cerrado) return res.status(423).json({ error: "El período está cerrado. Pedile al admin que lo reabra para hacer cambios." });
  const { notas } = req.body;
  if (!Array.isArray(notas)) return res.status(400).json({ error: "El campo notas debe ser un array." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (ev.tipo === 'examen') {
      // Cargar puntaje total para validar
      const ptotal = Number(ev.puntaje_total);
      for (const n of notas) {
        const eid = Number(n.estudiante_id);
        const v = n.puntos_obtenidos;
        if (!eid) continue;
        if (v == null || v === "") {
          // Borrar nota (si existía)
          await client.query("DELETE FROM notas_examen WHERE evaluacion_id=$1 AND estudiante_id=$2", [ev.id, eid]);
          continue;
        }
        const num = Number(v);
        if (isNaN(num) || num < 0 || num > ptotal) {
          throw new Error(`Puntos obtenidos inválidos para estudiante ${eid}: debe estar entre 0 y ${ptotal}.`);
        }
        await client.query(`
          INSERT INTO notas_examen (evaluacion_id, estudiante_id, puntos_obtenidos, updated_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (evaluacion_id, estudiante_id) DO UPDATE
            SET puntos_obtenidos = EXCLUDED.puntos_obtenidos, updated_at = NOW()
        `, [ev.id, eid, num]);
      }
    } else {
      // Cargar indicadores para validar puntaje_maximo
      const indsR = await client.query("SELECT id, puntaje_maximo FROM indicadores WHERE evaluacion_id=$1", [ev.id]);
      const maxPorInd = new Map(indsR.rows.map(r => [r.id, r.puntaje_maximo]));
      for (const n of notas) {
        const eid = Number(n.estudiante_id);
        const iid = Number(n.indicador_id);
        const v = n.puntaje;
        if (!eid || !iid) continue;
        if (!maxPorInd.has(iid)) continue; // indicador no pertenece a esta evaluación
        if (v == null || v === "") {
          await client.query("DELETE FROM notas_indicador WHERE evaluacion_id=$1 AND indicador_id=$2 AND estudiante_id=$3", [ev.id, iid, eid]);
          continue;
        }
        const num = Number(v);
        const max = maxPorInd.get(iid);
        if (!Number.isInteger(num) || num < 0 || num > max) {
          throw new Error(`Puntaje inválido para indicador ${iid}: debe ser entero entre 0 y ${max}.`);
        }
        await client.query(`
          INSERT INTO notas_indicador (evaluacion_id, indicador_id, estudiante_id, puntaje, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (evaluacion_id, indicador_id, estudiante_id) DO UPDATE
            SET puntaje = EXCLUDED.puntaje, updated_at = NOW()
        `, [ev.id, iid, eid, num]);
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("notas PUT:", e);
    res.status(400).json({ error: e.message || "Error al guardar notas." });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════════════
// FASE 3: PROMEDIOS DEL PERÍODO + ASISTENCIA AUTOMÁTICA + CIERRE/REAPERTURA
// ════════════════════════════════════════════════════════════════════════

// Tabla MEP de asistencia (% ausencias injustificadas → puntos /5)
function puntosAsistenciaMEP(porcentajeAusencias) {
  if (porcentajeAusencias < 10) return 5;
  if (porcentajeAusencias < 20) return 4;
  if (porcentajeAusencias < 30) return 3;
  if (porcentajeAusencias < 40) return 2;
  if (porcentajeAusencias < 50) return 1;
  return 0;
}

// Verifica si el período de una asignación está cerrado actualmente.
// Devuelve { cerrado: true, cerrado_en, cerrado_por } o { cerrado: false }
async function getEstadoPeriodo(profesor_id, seccion_id, materia_id, subgrupo, periodo) {
  const r = await pool.query(`
    SELECT id, cerrado_en, cerrado_por
    FROM periodos_cerrados
    WHERE profesor_id=$1 AND seccion_id=$2 AND materia_id=$3
      AND (($4::text IS NULL AND subgrupo IS NULL) OR subgrupo=$4)
      AND periodo=$5 AND reabierto_en IS NULL
    ORDER BY cerrado_en DESC
    LIMIT 1
  `, [profesor_id, seccion_id, materia_id, subgrupo || null, periodo]);
  if (!r.rows.length) return { cerrado: false };
  return { cerrado: true, ...r.rows[0] };
}

// Calcula los rubros para todos los estudiantes de una asignación.
// Devuelve { regla, estudiantes: [{estudiante_id, rubros, total, asistencia}] }
async function calcularPromediosAsignacion(profesor_id, seccion_id, materia_id, subgrupo, periodo) {
  const sub = subgrupo || null;

  // 1. Verificar acceso y obtener regla REAC
  const asig = await verificarAsignacion(profesor_id, seccion_id, materia_id, sub, periodo);
  if (!asig) throw new Error('Sin acceso a la asignación.');

  // 2. Cargar regla oficial
  let regla = null;
  if (asig.regla_id) {
    const r = await pool.query("SELECT * FROM materia_evaluacion_oficial WHERE id=$1", [asig.regla_id]);
    regla = r.rows[0] || null;
  }
  if (!regla) {
    throw new Error('No hay regla REAC para esta materia/nivel. No se pueden calcular promedios.');
  }

  // 3. Cargar todos los estudiantes activos de esta asignación
  const estudiantesR = await pool.query(`
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido, e.subgrupo,
      COALESCE(ad.no_significativa,false) AS adecuacion_no_significativa,
      COALESCE(ad.significativa,false) AS adecuacion_significativa,
      COALESCE(ad.acceso,false) AS adecuacion_acceso,
      COALESCE(ad.observacion,'') AS adecuacion_observacion
    FROM estudiantes e
    LEFT JOIN adecuaciones_estudiante ad ON ad.estudiante_id=e.id
    WHERE e.seccion_id = $1 AND e.activo = true
      AND (($2::text IS NULL) OR e.subgrupo = $2)
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
  `, [seccion_id, sub]);
  const estudiantes = estudiantesR.rows;

  // 3b. RAMA SIMPLIFICADA: para materias como Ética y Valores el profe
  // ingresa el % obtenido por rubro directamente. No usamos evaluaciones
  // individuales. Calculamos: pct_rubro × peso_rubro = puntos del rubro.
  if (asig.modo_simplificado) {
    const pesos = {
      cotidiano:  Number(regla.porc_cotidiano)  || 0,
      tareas:     Number(regla.porc_tareas)     || 0,
      pruebas:    Number(regla.porc_pruebas)    || 0,
      proyectos:  Number(regla.porc_proyectos)  || 0,
      asistencia: Number(regla.porc_asistencia) || 0,
    };

    // Cargar porcentajes guardados
    const csR = await pool.query(`
      SELECT estudiante_id, pct_cotidiano, pct_tareas, pct_pruebas, pct_proyectos
      FROM calificaciones_simplificadas
      WHERE asignacion_id = $1 AND periodo = $2
    `, [asig.id, periodo]);
    const porEst = new Map(csR.rows.map(r => [r.estudiante_id, r]));

    // Calcular asistencia (mismo patrón que el modo normal).
    // IMPORTANTE: la tabla sesiones_asistencia solo tiene la columna `lecciones`
    // (no lecciones_realizadas ni lecciones_planeadas). Hay que usar esa.
    const fechasSimpl = await obtenerRangoPeriodo(periodo);
    const totLeccR = await pool.query(`
      SELECT COALESCE(SUM(s.lecciones), 0)::int AS total
      FROM sesiones_asistencia s
      WHERE s.asignacion_id = $1
        AND s.fecha BETWEEN $2 AND $3
    `, [asig.id, fechasSimpl.desde, fechasSimpl.hasta]);
    const totalLeccionesGlobal = totLeccR.rows[0].total || 0;

    const ausR = await pool.query(`
      SELECT a.estudiante_id, COALESCE(SUM(a.lecciones_ausentes), 0)::int AS aus
      FROM asistencia a
      JOIN sesiones_asistencia s ON s.id = a.sesion_id
      WHERE s.asignacion_id = $1
        AND s.fecha BETWEEN $2 AND $3
        AND a.estado = 'A'
        AND a.justificada = false
      GROUP BY a.estudiante_id
    `, [asig.id, fechasSimpl.desde, fechasSimpl.hasta]);
    const ausPorEst = new Map(ausR.rows.map(r => [Number(r.estudiante_id), Number(r.aus)]));

    const resultado = estudiantes.map(e => {
      const cs = porEst.get(e.id) || {};
      const pCot = cs.pct_cotidiano != null ? Number(cs.pct_cotidiano) : null;
      const pTar = cs.pct_tareas    != null ? Number(cs.pct_tareas)    : null;
      const pPru = cs.pct_pruebas   != null ? Number(cs.pct_pruebas)   : null;
      const pPro = cs.pct_proyectos != null ? Number(cs.pct_proyectos) : null;

      // Puntos del rubro = (% obtenido / 100) × peso del rubro
      const ptosCot = pCot != null ? (pCot / 100) * pesos.cotidiano : 0;
      const ptosTar = pTar != null ? (pTar / 100) * pesos.tareas    : 0;
      const ptosPru = pPru != null ? (pPru / 100) * pesos.pruebas   : 0;
      const ptosPro = pPro != null ? (pPro / 100) * pesos.proyectos : 0;

      // Asistencia (idéntica al modo normal: tabla MEP de puntos)
      const ausentes = ausPorEst.get(e.id) || 0;
      const porcAusencias = totalLeccionesGlobal > 0 ? (ausentes / totalLeccionesGlobal) * 100 : 0;
      let ptosAsist = pesos.asistencia;
      if (porcAusencias > 0) {
        const tablaMep = [
          { hasta: 5,  ptos: 5 },{ hasta:10, ptos: 4 },{ hasta:15, ptos: 3 },
          { hasta:20,  ptos: 2 },{ hasta:25, ptos: 1 },{ hasta:100,ptos: 0 }
        ];
        const fila = tablaMep.find(f => porcAusencias <= f.hasta) || tablaMep[tablaMep.length-1];
        ptosAsist = (fila.ptos / 5) * pesos.asistencia;
      }

      const total = (ptosCot + ptosTar + ptosPru + ptosPro + (pesos.asistencia > 0 ? ptosAsist : 0));

      return {
        estudiante_id: e.id, cedula: e.cedula, nombre: e.nombre,
        primer_apellido: e.primer_apellido, segundo_apellido: e.segundo_apellido,
        adecuacion_no_significativa:e.adecuacion_no_significativa,
        adecuacion_significativa:e.adecuacion_significativa,
        adecuacion_acceso:e.adecuacion_acceso,adecuacion_observacion:e.adecuacion_observacion,
        rubros: {
          cotidiano: { pct: pCot, peso: pesos.cotidiano, nota_100: pCot },
          tarea:     { pct: pTar, peso: pesos.tareas,    nota_100: pTar },
          examen:    { pct: pPru, peso: pesos.pruebas,   nota_100: pPru },
          proyecto:  { pct: pPro, peso: pesos.proyectos, nota_100: pPro },
        },
        asistencia: {
          total_lecciones: totalLeccionesGlobal,
          lecciones_ausentes_injust: ausentes,
          porcentaje_ausencias: porcAusencias,
          pct: pesos.asistencia > 0 ? ptosAsist : 0,
          peso: pesos.asistencia,
        },
        total: Number(total.toFixed(2)),
        modo_simplificado: true,
      };
    });

    return { regla, estudiantes: resultado, modo_simplificado: true };
  }

  // 4. Cargar todas las evaluaciones del período para esta asignación, con sus notas
  const evalsR = await pool.query(`
    SELECT e.id, e.tipo, e.puntaje_total
    FROM evaluaciones e
    WHERE e.profesor_id = $1 AND e.seccion_id = $2 AND e.materia_id = $3
      AND (($4::text IS NULL AND e.subgrupo IS NULL) OR e.subgrupo=$4)
      AND e.periodo = $5
  `, [profesor_id, seccion_id, materia_id, sub, periodo]);

  // Para cada estudiante, acumuladores por tipo
  // Para exámenes: si la evaluación tiene valor_porcentual definido, vamos
  // sumando aporte directo (puntos/max × valor_porcentual). Si no (exámenes
  // viejos sin valor_porcentual), caemos al método anterior basado en puntos totales.
  const rubros = new Map(); // estudiante_id → { examen: {...}, tarea: {...}, ... }
  estudiantes.forEach(e => {
    rubros.set(e.id, {
      examen:    { obtenido: 0, max: 0, cant_evals: 0, cant_con_nota: 0, pct_sumado: 0, pct_max: 0, tiene_vp: false, sin_vp: false },
      tarea:     { obtenido: 0, max: 0, cant_evals: 0, cant_con_nota: 0 },
      cotidiano: { obtenido: 0, max: 0, cant_evals: 0, cant_con_nota: 0 },
      proyecto:  { obtenido: 0, max: 0, cant_evals: 0, cant_con_nota: 0 }
    });
  });

  // PRE-CÁLCULO: si algunos exámenes no tienen valor_porcentual guardado
  // (ej: se crearon antes de que existiera ese campo), les asignamos un VP
  // "virtual" con el peso restante distribuido equitativamente. Así siempre
  // podemos usar el modo VP (suma directa por examen) y evitamos caer al
  // modo LEGACY que promedia por puntaje total y da resultados incorrectos
  // cuando faltan notas en algún examen.
  //
  // Ejemplo del bug: rubro Pruebas 50%, dos exámenes de 25% cada uno,
  // estudiante saca 21/21 en el 1° y no hace el 2°.
  //   - Modo VP (correcto): (21/21)*25 = 25 puntos del rubro
  //   - Modo LEGACY (bug):  21/(21+18)*100 = 53.85 → *50/100 = 26.92
  // La diferencia es porque LEGACY asume que TODOS los puntos posibles del
  // rubro cuentan como una única masa, en vez de tratar cada examen aparte.
  const examenesEvals = evalsR.rows.filter(e => e.tipo === 'examen');
  let vpTotalAsignado = 0;
  let sinVpCount = 0;
  for (const ev of examenesEvals) {
    const vp = Number(ev.valor_porcentual || 0);
    if (vp > 0) vpTotalAsignado += vp;
    else sinVpCount++;
  }
  const pesoPruebasRubro = Number(regla.porc_pruebas || 0);
  const vpDisponibleRestante = Math.max(0, pesoPruebasRubro - vpTotalAsignado);
  const vpVirtualPorSinVp = (sinVpCount > 0 && vpDisponibleRestante > 0)
    ? vpDisponibleRestante / sinVpCount
    : 0;

  // Cargar notas por cada evaluación
  for (const ev of evalsR.rows) {
    if (ev.tipo === 'examen') {
      const ntx = await pool.query("SELECT estudiante_id, puntos_obtenidos FROM notas_examen WHERE evaluacion_id=$1", [ev.id]);
      const notasMap = new Map(ntx.rows.map(n => [Number(n.estudiante_id), Number(n.puntos_obtenidos)]));
      const ptotal = Number(ev.puntaje_total);
      const vpGuardado = Number(ev.valor_porcentual || 0);
      // Si no tiene VP guardado, usar el virtual calculado arriba
      const vp = vpGuardado > 0 ? vpGuardado : vpVirtualPorSinVp;
      for (const e of estudiantes) {
        const r = rubros.get(e.id).examen;
        r.cant_evals += 1;
        r.max += ptotal;
        if (vp > 0) {
          r.tiene_vp = true;
          r.pct_max += vp;
        } else {
          r.sin_vp = true;
        }
        if (notasMap.has(e.id) && notasMap.get(e.id) != null && !isNaN(notasMap.get(e.id))) {
          const puntos = notasMap.get(e.id);
          r.obtenido += puntos;
          r.cant_con_nota += 1;
          if (vp > 0 && ptotal > 0) {
            r.pct_sumado += (puntos / ptotal) * vp;
          }
        }
      }
    } else {
      // tarea, cotidiano, proyecto
      const indsR = await pool.query("SELECT id, puntaje_maximo FROM indicadores WHERE evaluacion_id=$1", [ev.id]);
      const indMaxMap = new Map(indsR.rows.map(i => [Number(i.id), Number(i.puntaje_maximo)]));
      const ntxR = await pool.query("SELECT estudiante_id, indicador_id, puntaje FROM notas_indicador WHERE evaluacion_id=$1", [ev.id]);
      // Sumar por estudiante
      const obtPorEst = new Map(); // estudiante_id → suma de puntajes en esta evaluación
      const tieneAlgo = new Map(); // estudiante_id → bool si tiene al menos un puntaje
      ntxR.rows.forEach(n => {
        const eid = Number(n.estudiante_id);
        if (n.puntaje == null) return;
        obtPorEst.set(eid, (obtPorEst.get(eid) || 0) + Number(n.puntaje));
        tieneAlgo.set(eid, true);
      });
      const sumaMaxEv = indsR.rows.reduce((s, i) => s + Number(i.puntaje_maximo), 0);
      for (const e of estudiantes) {
        const r = rubros.get(e.id)[ev.tipo];
        r.cant_evals += 1;
        r.max += sumaMaxEv;
        if (obtPorEst.has(e.id)) {
          r.obtenido += obtPorEst.get(e.id);
          if (tieneAlgo.get(e.id)) r.cant_con_nota += 1;
        }
      }
    }
  }

  // 5. Calcular % de asistencia automáticamente desde el módulo de asistencia
  const fechas = await obtenerRangoPeriodo(periodo);
  // Total de lecciones impartidas en el período por esta asignación
  // (sumamos sesiones_asistencia.lecciones * cantidad_estudiantes_en_sesión)
  // Pero para cada estudiante calculamos sus propias ausencias.
  // Estrategia: por asignación, sumamos total lecciones impartidas
  // y por estudiante, sumamos lecciones_ausentes donde justificada=false.
  const sesionesR = await pool.query(`
    SELECT s.id, s.lecciones
    FROM sesiones_asistencia s
    WHERE s.asignacion_id = $1
      AND s.fecha BETWEEN $2 AND $3
  `, [asig.id, fechas.desde, fechas.hasta]);
  const totalLecciones = sesionesR.rows.reduce((s, r) => s + Number(r.lecciones), 0);

  const ausR = await pool.query(`
    SELECT a.estudiante_id, COALESCE(SUM(a.lecciones_ausentes), 0) AS ausentes
    FROM asistencia a
    JOIN sesiones_asistencia s ON s.id = a.sesion_id
    WHERE s.asignacion_id = $1
      AND s.fecha BETWEEN $2 AND $3
      AND a.estado = 'A'
      AND a.justificada = false
    GROUP BY a.estudiante_id
  `, [asig.id, fechas.desde, fechas.hasta]);
  const ausPorEst = new Map(ausR.rows.map(r => [Number(r.estudiante_id), Number(r.ausentes)]));

  // 6. Armar respuesta por estudiante
  const pesos = {
    cotidiano: Number(regla.porc_cotidiano) || 0,
    tareas:    Number(regla.porc_tareas) || 0,
    pruebas:   Number(regla.porc_pruebas) || 0,
    proyectos: Number(regla.porc_proyectos) || 0,
    asistencia: Number(regla.porc_asistencia) || 0
  };

  const resultado = estudiantes.map(e => {
    const r = rubros.get(e.id);
    // Nota /100 por rubro
    const notaCotid = r.cotidiano.max > 0 ? (r.cotidiano.obtenido * 100) / r.cotidiano.max : null;
    const notaTar   = r.tarea.max > 0 ? (r.tarea.obtenido * 100) / r.tarea.max : null;
    const notaExm   = r.examen.max > 0 ? (r.examen.obtenido * 100) / r.examen.max : null;
    const notaProy  = r.proyecto.max > 0 ? (r.proyecto.obtenido * 100) / r.proyecto.max : null;
    // % aplicando peso
    const pctCotid = notaCotid !== null ? (notaCotid * pesos.cotidiano) / 100 : 0;
    const pctTar   = notaTar !== null   ? (notaTar   * pesos.tareas) / 100    : 0;
    // Para exámenes: si hay al menos un examen con VP (real o virtual),
    // usar SIEMPRE el modo de suma directa por VP. Esto asegura que la
    // nota de cada examen se calcula de forma independiente, sin que la
    // ausencia de nota en uno afecte matemáticamente a los otros.
    //
    // Solo caemos al modo LEGACY (proporcional al puntaje total) si por
    // algún motivo NINGÚN examen tiene VP ni se pudo calcular uno virtual.
    let pctExm;
    if (r.examen.tiene_vp) {
      // Modo VP (correcto): suma directa por examen
      pctExm = r.examen.pct_sumado;
    } else {
      // Modo LEGACY (fallback, no debería activarse en la práctica)
      pctExm = notaExm !== null ? (notaExm * pesos.pruebas) / 100 : 0;
    }
    const pctProy  = notaProy !== null  ? (notaProy  * pesos.proyectos) / 100 : 0;
    // Asistencia: si total=0 (sin sesiones registradas), darle el máximo
    let porcAusencias = 0;
    const ausentes = ausPorEst.get(e.id) || 0;
    if (totalLecciones > 0) {
      porcAusencias = (ausentes * 100) / totalLecciones;
    }
    const ptosAsist = puntosAsistenciaMEP(porcAusencias);
    // Si el rubro asistencia es 0% (no aplica), no contar puntos
    const pctAsist = pesos.asistencia > 0 ? Math.min(ptosAsist, pesos.asistencia) : 0;
    const totalPct = pctCotid + pctTar + pctExm + pctProy + pctAsist;
    return {
      estudiante_id: e.id,
      cedula: e.cedula,
      nombre: e.nombre,
      primer_apellido: e.primer_apellido,
      segundo_apellido: e.segundo_apellido,
      subgrupo: e.subgrupo,
      adecuacion_no_significativa:e.adecuacion_no_significativa,
      adecuacion_significativa:e.adecuacion_significativa,
      adecuacion_acceso:e.adecuacion_acceso,adecuacion_observacion:e.adecuacion_observacion,
      rubros: {
        cotidiano: { ...r.cotidiano, nota_100: notaCotid, pct: pctCotid, peso: pesos.cotidiano },
        tarea:     { ...r.tarea,     nota_100: notaTar,   pct: pctTar,   peso: pesos.tareas },
        examen:    { ...r.examen,    nota_100: notaExm,   pct: pctExm,   peso: pesos.pruebas },
        proyecto:  { ...r.proyecto,  nota_100: notaProy,  pct: pctProy,  peso: pesos.proyectos }
      },
      asistencia: {
        total_lecciones: totalLecciones,
        lecciones_ausentes_injust: ausentes,
        porcentaje_ausencias: porcAusencias,
        puntos_mep: ptosAsist,
        pct: pctAsist,
        peso: pesos.asistencia
      },
      total: totalPct
    };
  });

  return { asignacion: asig, regla, estudiantes: resultado };
}

// ── GET /promedio/seccion ─────────────────────────────────────────────
// Devuelve el desglose por rubro de todos los estudiantes para una asignación.
router.get("/promedio/seccion", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { seccion_id, materia_id, subgrupo, periodo } = req.query;
  if (!seccion_id || !materia_id || !periodo) {
    return res.status(400).json({ error: "Faltan parámetros (seccion_id, materia_id, periodo)." });
  }
  try {
    const data = await calcularPromediosAsignacion(u.id, seccion_id, materia_id, subgrupo, periodo);
    const cierre = await getEstadoPeriodo(u.id, seccion_id, materia_id, subgrupo, periodo);
    res.json({ ...data, cierre });
  } catch (e) {
    console.error("promedio/seccion:", e);
    res.status(400).json({ error: e.message || "Error al calcular promedios." });
  }
});

// ── GET /promedio/anual ───────────────────────────────────────────────
// Devuelve I + II período + promedio anual + estado (aprobado/aplazado) por estudiante.
router.get("/promedio/anual", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { seccion_id, materia_id, subgrupo } = req.query;
  if (!seccion_id || !materia_id) {
    return res.status(400).json({ error: "Faltan parámetros (seccion_id, materia_id)." });
  }
  try {
    // Necesitamos el nivel de la sección para saber qué nota mínima aplica (65 o 70)
    const secR = await pool.query("SELECT nivel FROM secciones WHERE id=$1", [seccion_id]);
    if (!secR.rows.length) return res.status(404).json({ error: "Sección no encontrada." });
    const nivel = Number(secR.rows[0].nivel);
    const notaMin = nivel <= 9 ? 65 : 70;

    // Calcular ambos períodos. Si no hay asignación en uno, ese período queda en null.
    let dataI = null, dataII = null;
    try { dataI = await calcularPromediosAsignacion(u.id, seccion_id, materia_id, subgrupo, 'I Período'); } catch(e) { /* no asignación en I */ }
    try { dataII = await calcularPromediosAsignacion(u.id, seccion_id, materia_id, subgrupo, 'II Período'); } catch(e) { /* no asignación en II */ }

    if (!dataI && !dataII) {
      return res.status(403).json({ error: "Sin acceso a esta asignación en ningún período." });
    }

    // Lista de estudiantes (de cualquier período que exista)
    const base = dataI || dataII;
    // Mapas por estudiante
    const mapI  = new Map((dataI?.estudiantes||[]).map(s => [s.estudiante_id, s]));
    const mapII = new Map((dataII?.estudiantes||[]).map(s => [s.estudiante_id, s]));

    const todosIds = new Set([...mapI.keys(), ...mapII.keys()]);
    const estudiantes = [...todosIds].map(eid => {
      const sI  = mapI.get(eid);
      const sII = mapII.get(eid);
      const ref = sI || sII;
      const notaI  = sI  ? sI.total  : null;
      const notaII = sII ? sII.total : null;
      let anual = null;
      if (notaI != null && notaII != null) {
        anual = (notaI + notaII) / 2;
      } else if (notaI != null) {
        anual = notaI; // si solo hay un período (caso semestrales o no inicio del año)
      } else if (notaII != null) {
        anual = notaII;
      }
      const estado = anual != null
        ? (anual >= notaMin ? 'Aprobado' : 'Aplazado')
        : 'Sin datos';
      return {
        estudiante_id: eid,
        cedula: ref.cedula,
        nombre: ref.nombre,
        primer_apellido: ref.primer_apellido,
        segundo_apellido: ref.segundo_apellido,
        subgrupo: ref.subgrupo,
        adecuacion_no_significativa:ref.adecuacion_no_significativa,
        adecuacion_significativa:ref.adecuacion_significativa,
        adecuacion_acceso:ref.adecuacion_acceso,
        adecuacion_observacion:ref.adecuacion_observacion,
        nota_I: notaI,
        nota_II: notaII,
        promedio_anual: anual,
        estado,
        nota_minima_aprobacion: notaMin
      };
    });
    // Ordenar
    estudiantes.sort((a,b) => {
      const c = (a.primer_apellido||'').localeCompare(b.primer_apellido||'', 'es');
      if (c !== 0) return c;
      const c2 = (a.segundo_apellido||'').localeCompare(b.segundo_apellido||'', 'es');
      if (c2 !== 0) return c2;
      return (a.nombre||'').localeCompare(b.nombre||'', 'es');
    });

    // Estado de cierre por período
    const cierreI  = await getEstadoPeriodo(u.id, seccion_id, materia_id, subgrupo, 'I Período');
    const cierreII = await getEstadoPeriodo(u.id, seccion_id, materia_id, subgrupo, 'II Período');

    res.json({
      asignacion: base.asignacion,
      regla: base.regla,
      nivel,
      nota_minima_aprobacion: notaMin,
      estudiantes,
      cierre_I:  cierreI,
      cierre_II: cierreII
    });
  } catch (e) {
    console.error("promedio/anual:", e);
    res.status(400).json({ error: e.message || "Error al calcular promedio anual." });
  }
});

// ── POST /periodo/cerrar ──────────────────────────────────────────────
// El profesor cierra el período de una asignación. Las notas quedan
// read-only (validado en backend al intentar crear/editar/borrar evaluación
// o guardar notas).
router.post("/periodo/cerrar", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { seccion_id, materia_id, subgrupo, periodo } = req.body;
  if (!seccion_id || !materia_id || !periodo) {
    return res.status(400).json({ error: "Faltan parámetros." });
  }
  // Verificar que tenga la asignación
  const asig = await verificarAsignacion(u.id, seccion_id, materia_id, subgrupo, periodo);
  if (!asig) return res.status(403).json({ error: "Sin acceso a esta asignación." });
  // Verificar que no esté ya cerrado
  const estado = await getEstadoPeriodo(u.id, seccion_id, materia_id, subgrupo, periodo);
  if (estado.cerrado) return res.status(400).json({ error: "El período ya está cerrado." });
  // Insertar registro
  await pool.query(`
    INSERT INTO periodos_cerrados (profesor_id, seccion_id, materia_id, subgrupo, periodo, cerrado_en, cerrado_por)
    VALUES ($1, $2, $3, $4, $5, NOW(), $6)
  `, [u.id, seccion_id, materia_id, subgrupo || null, periodo, u.id]);
  res.json({ ok: true });
});

// ── POST /periodo/reabrir ─────────────────────────────────────────────
// Solo admin puede reabrir un período cerrado.
router.post("/periodo/reabrir", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if (u.rol !== 'admin') {
    return res.status(403).json({ error: "Solo el administrador puede reabrir períodos cerrados." });
  }
  const { profesor_id, seccion_id, materia_id, subgrupo, periodo, motivo } = req.body;
  if (!profesor_id || !seccion_id || !materia_id || !periodo) {
    return res.status(400).json({ error: "Faltan parámetros." });
  }
  if (!motivo || !String(motivo).trim()) {
    return res.status(400).json({ error: "Indicá el motivo de la reapertura." });
  }
  // Cerrar el registro actual (marcar reabierto_en)
  const r = await pool.query(`
    UPDATE periodos_cerrados
    SET reabierto_en = NOW(), reabierto_por = $1, motivo_reapertura = $2
    WHERE profesor_id=$3 AND seccion_id=$4 AND materia_id=$5
      AND (($6::text IS NULL AND subgrupo IS NULL) OR subgrupo=$6)
      AND periodo=$7 AND reabierto_en IS NULL
    RETURNING id
  `, [u.id, motivo.trim(), profesor_id, seccion_id, materia_id, subgrupo || null, periodo]);
  if (!r.rows.length) {
    return res.status(404).json({ error: "No hay un período cerrado para reabrir." });
  }
  res.json({ ok: true });
});

// ── GET /periodos/cerrados ───────────────────────────────────────────
// Lista todos los períodos cerrados del profesor (para mostrar estado).
// Si es admin, devuelve TODOS los cerrados de TODOS los profesores.
router.get("/periodos/cerrados", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if (u.rol === 'admin') {
    const r = await pool.query(`
      SELECT pc.*, s.nombre AS seccion_nombre, m.nombre AS materia_nombre,
             prof.primer_apellido AS prof_ap1, prof.nombre AS prof_nombre
      FROM periodos_cerrados pc
      JOIN secciones s ON s.id = pc.seccion_id
      JOIN materias m ON m.id = pc.materia_id
      JOIN usuarios prof ON prof.id = pc.profesor_id
      WHERE pc.reabierto_en IS NULL
      ORDER BY pc.cerrado_en DESC
    `);
    return res.json(r.rows);
  }
  const r = await pool.query(`
    SELECT pc.*, s.nombre AS seccion_nombre, m.nombre AS materia_nombre
    FROM periodos_cerrados pc
    JOIN secciones s ON s.id = pc.seccion_id
    JOIN materias m ON m.id = pc.materia_id
    WHERE pc.profesor_id=$1 AND pc.reabierto_en IS NULL
    ORDER BY pc.cerrado_en DESC
  `, [u.id]);
  res.json(r.rows);
});

// ════════════════════════════════════════════════════════════════════
//  MODO SIMPLIFICADO — porcentajes directos por rubro
// ════════════════════════════════════════════════════════════════════
// Usado por materias marcadas como "modo_simplificado=true". El profe ingresa
// el % obtenido por rubro (no tareas/cotidianos individuales) y el sistema
// aplica los pesos del REAC para calcular la nota final.

// GET: trae los porcentajes guardados para una asignación + periodo.
// Devuelve un array con una fila por estudiante de la sección.
router.get("/simplificado", requireAuth, async (req, res) => {
  const { asignacion_id, periodo } = req.query;
  if (!asignacion_id || !periodo) return res.status(400).json({ error: "Faltan parámetros." });
  try {
    // Verificar permisos: solo el profesor de la asignación o admin/staff
    const u = req.session.usuario;
    const asigR = await pool.query("SELECT profesor_id, seccion_id FROM asignaciones WHERE id=$1", [asignacion_id]);
    if (!asigR.rows.length) return res.status(404).json({ error: "Asignación no encontrada" });
    const asig = asigR.rows[0];
    if (u.rol !== "admin" && Number(asig.profesor_id) !== Number(u.id)) return res.status(403).json({ error: "Solo el profesor a cargo o administración puede consultar estas calificaciones." });

    // Traer todos los estudiantes activos de la sección + sus calificaciones (si hay)
    const r = await pool.query(`
      SELECT e.id AS estudiante_id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
             cs.pct_cotidiano, cs.pct_tareas, cs.pct_pruebas, cs.pct_proyectos, cs.observaciones,
             cs.updated_at
      FROM estudiantes e
      LEFT JOIN calificaciones_simplificadas cs
        ON cs.estudiante_id = e.id AND cs.asignacion_id = $1 AND cs.periodo = $2
      WHERE e.seccion_id = $3 AND e.activo = true
      ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
    `, [asignacion_id, periodo, asig.seccion_id]);
    res.json(r.rows);
  } catch (e) {
    console.error("GET /simplificado:", e);
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// POST: guarda los porcentajes de un estudiante. Si ya existía la fila, la
// actualiza. Valida que la materia esté en modo simplificado.
router.post("/simplificado", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { asignacion_id, estudiante_id, periodo, pct_cotidiano, pct_tareas, pct_pruebas, pct_proyectos, observaciones } = req.body;
  if (!asignacion_id || !estudiante_id || !periodo) {
    return res.status(400).json({ error: "asignacion_id, estudiante_id y periodo son requeridos." });
  }

  try {
    // Verificar permisos y que la asignación O su materia esté en modo simplificado
    const aR = await pool.query(`
      SELECT a.profesor_id,
             (a.modo_simplificado OR COALESCE(m.modo_simplificado, false)) AS modo_simplificado
      FROM asignaciones a
      JOIN materias m ON m.id = a.materia_id
      WHERE a.id = $1`, [asignacion_id]);
    if (!aR.rows.length) return res.status(404).json({ error: "Asignación no encontrada" });
    if (u.rol !== "admin" && Number(aR.rows[0].profesor_id) !== Number(u.id)) {
      return res.status(403).json({ error: "Solo el profesor a cargo puede calificar." });
    }
    if (!aR.rows[0].modo_simplificado) {
      return res.status(400).json({ error: "Esta asignación no está en modo simplificado." });
    }

    // Validar rango 0-100 (NULL si vacío)
    const limpiar = v => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (isNaN(n) || n < 0 || n > 100) throw { status:400, error:`Valor inválido: ${v}. Debe estar entre 0 y 100.` };
      return n;
    };
    const pCot = limpiar(pct_cotidiano);
    const pTar = limpiar(pct_tareas);
    const pPru = limpiar(pct_pruebas);
    const pPro = limpiar(pct_proyectos);

    // Upsert: si existe la fila, actualiza; si no, inserta
    await pool.query(`
      INSERT INTO calificaciones_simplificadas
        (asignacion_id, estudiante_id, periodo, pct_cotidiano, pct_tareas, pct_pruebas, pct_proyectos, observaciones, registrado_por, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
      ON CONFLICT (asignacion_id, estudiante_id, periodo) DO UPDATE
        SET pct_cotidiano=EXCLUDED.pct_cotidiano,
            pct_tareas=EXCLUDED.pct_tareas,
            pct_pruebas=EXCLUDED.pct_pruebas,
            pct_proyectos=EXCLUDED.pct_proyectos,
            observaciones=EXCLUDED.observaciones,
            registrado_por=EXCLUDED.registrado_por,
            updated_at=NOW()
    `, [asignacion_id, estudiante_id, periodo, pCot, pTar, pPru, pPro, observaciones||"", u.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.status && e.error) return res.status(e.status).json({ error: e.error });
    console.error("POST /simplificado:", e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  HISTORIAL PREVIO DEL ESTUDIANTE (cambios de sección/subgrupo)
// ════════════════════════════════════════════════════════════════════
// Si un estudiante cambia de sección/subgrupo en medio del período, las
// notas que tenía con OTRO profesor (o el mismo profe con otra asignación)
// no se borran — siguen en la BD vinculadas a la evaluación original.
// Estos endpoints permiten:
//   - GET /historial-previo: ver qué evaluaciones tiene el estudiante en
//     OTRA asignación de la misma materia/periodo (no la actual)
//   - POST /copiar-evaluacion: el profe nuevo trae una evaluación a su
//     asignación creando una copia con los mismos datos.

// GET /historial-previo?asignacion_id=X&estudiante_id=Y
// Devuelve evaluaciones de OTRAS asignaciones (misma materia + periodo) con
// la nota que el estudiante tenía. El profe ve qué se le calificó antes.
router.get("/historial-previo", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { asignacion_id, estudiante_id } = req.query;
  if (!asignacion_id || !estudiante_id) {
    return res.status(400).json({ error: "asignacion_id y estudiante_id son requeridos." });
  }
  try {
    // Datos de la asignación actual (para filtrar materia + periodo)
    const aR = await pool.query(`
      SELECT a.materia_id, a.periodo, a.profesor_id
      FROM asignaciones a WHERE a.id = $1
    `, [asignacion_id]);
    if (!aR.rows.length) return res.status(404).json({ error: "Asignación no encontrada" });
    const a = aR.rows[0];

    // Permisos: solo el profe a cargo o admin/staff
    if (u.rol !== "admin" && Number(a.profesor_id) !== Number(u.id)) {
      return res.status(403).json({ error: "Sin permisos." });
    }

    // Buscar evaluaciones de OTRAS asignaciones (misma materia + periodo) donde
    // el estudiante tenga nota registrada. Incluye datos del profe y sección
    // anteriores para que el profe nuevo pueda contextualizar.
    const r = await pool.query(`
      SELECT
        e.id AS evaluacion_id, e.tipo, e.nombre, e.descripcion, e.fecha, e.fecha_asignacion,
        e.puntaje_total, e.valor_porcentual, e.subgrupo,
        prof.primer_apellido AS prof_ap1, prof.segundo_apellido AS prof_ap2, prof.nombre AS prof_nombre,
        sec.nombre AS seccion_nombre,
        -- Para EXÁMENES: nota directa
        ne.puntos_obtenidos AS examen_puntos,
        -- Para tarea/cotidiano/proyecto: sumamos notas de indicadores y total posible
        (SELECT COALESCE(SUM(ni.puntaje),0) FROM notas_indicador ni
          WHERE ni.evaluacion_id = e.id AND ni.estudiante_id = $2) AS ind_obtenido,
        (SELECT COALESCE(SUM(i.puntaje_maximo),0) FROM indicadores i
          WHERE i.evaluacion_id = e.id) AS ind_maximo,
        (SELECT COUNT(*) FROM notas_indicador ni
          WHERE ni.evaluacion_id = e.id AND ni.estudiante_id = $2 AND ni.puntaje IS NOT NULL) AS ind_calificados
      FROM evaluaciones e
      JOIN usuarios prof ON prof.id = e.profesor_id
      JOIN secciones sec ON sec.id = e.seccion_id
      LEFT JOIN notas_examen ne ON ne.evaluacion_id = e.id AND ne.estudiante_id = $2
      WHERE e.materia_id = $3
        AND e.periodo = $4
        AND (
          -- Solo evaluaciones donde el estudiante TIENE nota registrada
          ne.puntos_obtenidos IS NOT NULL
          OR EXISTS(SELECT 1 FROM notas_indicador ni
                    WHERE ni.evaluacion_id = e.id AND ni.estudiante_id = $2 AND ni.puntaje IS NOT NULL)
        )
        -- Y NO sean evaluaciones de la asignación actual
        AND NOT (e.profesor_id = (SELECT profesor_id FROM asignaciones WHERE id = $1)
                 AND e.seccion_id = (SELECT seccion_id FROM asignaciones WHERE id = $1)
                 AND COALESCE(e.subgrupo,'') = COALESCE((SELECT subgrupo FROM asignaciones WHERE id = $1),''))
      ORDER BY e.fecha DESC, e.tipo
    `, [asignacion_id, estudiante_id, a.materia_id, a.periodo]);

    res.json(r.rows.map(row => {
      const profe = `${row.prof_nombre||''} ${row.prof_ap1||''} ${row.prof_ap2||''}`.replace(/\s+/g,' ').trim();
      // Calcular nota normalizada (sobre el puntaje total)
      let nota_obtenida = null, nota_maxima = null;
      if (row.tipo === 'examen') {
        nota_obtenida = row.examen_puntos;
        nota_maxima = row.puntaje_total;
      } else {
        nota_obtenida = row.ind_obtenido;
        nota_maxima = row.ind_maximo;
      }
      return {
        evaluacion_id: row.evaluacion_id,
        tipo: row.tipo,
        nombre: row.nombre,
        descripcion: row.descripcion,
        fecha: row.fecha,
        fecha_asignacion: row.fecha_asignacion,
        puntaje_total: row.puntaje_total,
        valor_porcentual: row.valor_porcentual,
        subgrupo_origen: row.subgrupo,
        seccion_origen: row.seccion_nombre,
        profesor_origen: profe,
        nota_obtenida,
        nota_maxima,
        indicadores_calificados: parseInt(row.ind_calificados) || 0,
      };
    }));
  } catch (e) {
    console.error("GET /historial-previo:", e);
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// POST /jalar-nota
// Body: { evaluacion_destino_id, evaluacion_origen_id, estudiante_id }
// Copia la nota de UN estudiante desde la evaluacion_origen a la evaluacion_destino
// (que YA existe en la asignación del profe nuevo). NO crea nada nuevo —
// solo escribe en notas_examen o notas_indicador.
router.post("/jalar-nota", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { evaluacion_destino_id, evaluacion_origen_id, estudiante_id } = req.body;
  if (!evaluacion_destino_id || !evaluacion_origen_id || !estudiante_id) {
    return res.status(400).json({ error: "Faltan datos." });
  }
  if (Number(evaluacion_destino_id) === Number(evaluacion_origen_id)) {
    return res.status(400).json({ error: "Origen y destino son la misma evaluación." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Cargar ambas evaluaciones
    const dR = await client.query(`SELECT * FROM evaluaciones WHERE id = $1`, [evaluacion_destino_id]);
    const oR = await client.query(`SELECT * FROM evaluaciones WHERE id = $1`, [evaluacion_origen_id]);
    if (!dR.rows.length) throw { status:404, error:"Evaluación destino no encontrada" };
    if (!oR.rows.length) throw { status:404, error:"Evaluación origen no encontrada" };
    const dest = dR.rows[0];
    const orig = oR.rows[0];

    // Validar permisos sobre la destino
    if (u.rol !== "admin" && Number(dest.profesor_id) !== Number(u.id)) {
      throw { status:403, error:"Solo el profesor a cargo puede jalar notas a su evaluación." };
    }

    // Validar coherencia
    if (orig.tipo !== dest.tipo) {
      throw { status:400, error:`Las evaluaciones son de distinto tipo (${orig.tipo} → ${dest.tipo}).` };
    }
    if (orig.materia_id !== dest.materia_id || orig.periodo !== dest.periodo) {
      throw { status:400, error:"Las evaluaciones no son de la misma materia/período." };
    }

    if (dest.tipo === 'examen') {
      // EXAMEN: copiar puntos_obtenidos.
      // Si los puntajes totales son distintos, escalamos proporcionalmente
      // para no inflar/desinflar la nota.
      const neR = await client.query(
        `SELECT puntos_obtenidos FROM notas_examen
         WHERE evaluacion_id = $1 AND estudiante_id = $2`,
        [evaluacion_origen_id, estudiante_id]
      );
      if (!neR.rows.length || neR.rows[0].puntos_obtenidos == null) {
        throw { status:400, error:"El estudiante no tiene nota en la evaluación origen." };
      }
      let puntosFinal = Number(neR.rows[0].puntos_obtenidos);
      const ptDest = Number(dest.puntaje_total) || 0;
      const ptOrig = Number(orig.puntaje_total) || 0;
      // Escalar si puntajes totales difieren
      let escalado = false;
      if (ptDest > 0 && ptOrig > 0 && ptDest !== ptOrig) {
        puntosFinal = (puntosFinal / ptOrig) * ptDest;
        escalado = true;
      }
      // Upsert
      await client.query(`
        INSERT INTO notas_examen (evaluacion_id, estudiante_id, puntos_obtenidos, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (evaluacion_id, estudiante_id) DO UPDATE
          SET puntos_obtenidos = EXCLUDED.puntos_obtenidos, updated_at = NOW()
      `, [evaluacion_destino_id, estudiante_id, puntosFinal]);

      await client.query("COMMIT");
      console.log(`[CALIF] Nota EXAMEN jalada: eval ${evaluacion_origen_id} → ${evaluacion_destino_id}, estudiante ${estudiante_id}, por ${u.id} (${u.rol}). ${escalado ? `Escalado de ${ptOrig} → ${ptDest}` : 'Sin escalado.'}`);
      return res.json({
        ok: true,
        puntos_aplicados: Number(puntosFinal.toFixed(2)),
        escalado,
        puntaje_total_destino: ptDest,
        puntaje_total_origen: ptOrig,
      });
    }

    // TAREA / COTIDIANO / PROYECTO: jalar notas por indicador.
    // Hacemos match por ORDEN (1° con 1°, 2° con 2°...) porque los nombres
    // de indicadores pueden ser distintos entre profes.
    const indsOrigR = await client.query(
      `SELECT id, orden, puntaje_maximo FROM indicadores WHERE evaluacion_id = $1 ORDER BY orden`,
      [evaluacion_origen_id]
    );
    const indsDestR = await client.query(
      `SELECT id, orden, puntaje_maximo FROM indicadores WHERE evaluacion_id = $1 ORDER BY orden`,
      [evaluacion_destino_id]
    );
    if (!indsDestR.rows.length) {
      throw { status:400, error:"La evaluación destino no tiene indicadores. Agregalos primero." };
    }
    if (!indsOrigR.rows.length) {
      throw { status:400, error:"La evaluación origen no tiene indicadores con datos." };
    }

    // Traer las notas del estudiante en origen, indexadas por id de indicador
    const notasOrigR = await client.query(
      `SELECT indicador_id, puntaje FROM notas_indicador
       WHERE evaluacion_id = $1 AND estudiante_id = $2 AND puntaje IS NOT NULL`,
      [evaluacion_origen_id, estudiante_id]
    );
    if (!notasOrigR.rows.length) {
      throw { status:400, error:"El estudiante no tiene notas en los indicadores de la evaluación origen." };
    }
    const notasOrigMap = new Map(notasOrigR.rows.map(r => [r.indicador_id, r.puntaje]));

    // Match por orden: para cada indicador del destino, buscamos el origen con la misma posición
    const indsOrigPorOrden = new Map(indsOrigR.rows.map(i => [i.orden, i]));

    let aplicados = 0, omitidos = 0, escalados = 0;
    const detalles = [];

    for (const indDest of indsDestR.rows) {
      const indOrig = indsOrigPorOrden.get(indDest.orden);
      if (!indOrig) {
        omitidos++;
        detalles.push(`Indicador ${indDest.orden}: sin equivalente en origen.`);
        continue;
      }
      const puntajeOrig = notasOrigMap.get(indOrig.id);
      if (puntajeOrig == null) {
        omitidos++;
        detalles.push(`Indicador ${indDest.orden}: sin nota en origen.`);
        continue;
      }
      let puntajeFinal = Number(puntajeOrig);
      // Escalar si los máximos difieren
      if (indDest.puntaje_maximo !== indOrig.puntaje_maximo) {
        puntajeFinal = (puntajeFinal / indOrig.puntaje_maximo) * indDest.puntaje_maximo;
        escalados++;
        detalles.push(`Indicador ${indDest.orden}: escalado de ${puntajeOrig}/${indOrig.puntaje_maximo} → ${puntajeFinal.toFixed(1)}/${indDest.puntaje_maximo}`);
      } else {
        detalles.push(`Indicador ${indDest.orden}: ${puntajeFinal}/${indDest.puntaje_maximo}`);
      }
      // Redondear al entero porque puntaje en BD es INTEGER
      puntajeFinal = Math.round(puntajeFinal);
      // Asegurar que no sobrepasa el máximo (por redondeo)
      puntajeFinal = Math.min(puntajeFinal, indDest.puntaje_maximo);

      // Upsert
      await client.query(`
        INSERT INTO notas_indicador (evaluacion_id, indicador_id, estudiante_id, puntaje, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (evaluacion_id, indicador_id, estudiante_id) DO UPDATE
          SET puntaje = EXCLUDED.puntaje, updated_at = NOW()
      `, [evaluacion_destino_id, indDest.id, estudiante_id, puntajeFinal]);
      aplicados++;
    }

    await client.query("COMMIT");
    console.log(`[CALIF] Notas INDICADORES jaladas: eval ${evaluacion_origen_id} → ${evaluacion_destino_id}, estudiante ${estudiante_id}, por ${u.id} (${u.rol}). Aplicados:${aplicados} Omitidos:${omitidos} Escalados:${escalados}`);
    res.json({
      ok: true,
      tipo: 'indicadores',
      aplicados, omitidos, escalados,
      cantidad_indicadores_origen: indsOrigR.rows.length,
      cantidad_indicadores_destino: indsDestR.rows.length,
      detalles,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.status && e.error) return res.status(e.status).json({ error: e.error });
    console.error("POST /jalar-nota:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /mis-evaluaciones-misma-materia?asignacion_id=X
// Devuelve las evaluaciones que el profe ya tiene en su asignación (mismas
// materia + período). Sirve para el dropdown del modal "historial previo":
// el profe elige a cuál de SUS evaluaciones jalar la nota.
router.get("/mis-evaluaciones-misma-materia", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { asignacion_id } = req.query;
  if (!asignacion_id) return res.status(400).json({ error: "asignacion_id requerido" });
  try {
    const aR = await pool.query(
      `SELECT profesor_id, seccion_id, materia_id, subgrupo, periodo
       FROM asignaciones WHERE id = $1`, [asignacion_id]
    );
    if (!aR.rows.length) return res.status(404).json({ error: "Asignación no encontrada" });
    const a = aR.rows[0];
    if (u.rol !== "admin" && Number(a.profesor_id) !== Number(u.id)) return res.status(403).json({ error: "Solo el profesor a cargo o administración puede consultar estas evaluaciones." });

    const r = await pool.query(`
      SELECT id, tipo, nombre, fecha, puntaje_total,
        (SELECT COUNT(*) FROM indicadores i WHERE i.evaluacion_id = e.id) AS cant_indicadores
      FROM evaluaciones e
      WHERE e.profesor_id = $1
        AND e.seccion_id = $2
        AND e.materia_id = $3
        AND COALESCE(e.subgrupo,'') = COALESCE($4,'')
        AND e.periodo = $5
      ORDER BY e.tipo, e.fecha
    `, [a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo, a.periodo]);
    res.json(r.rows);
  } catch (e) {
    console.error("GET mis-evaluaciones-misma-materia:", e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
//  GET /evaluaciones-copiables?asignacion_id=X&tipo=cotidiano
//
//  Devuelve las evaluaciones del MISMO PROFE + MISMA MATERIA, pero de OTRAS
//  secciones/subgrupos/períodos. Sirve para el botón "Copiar de otra sección"
//  en el modal de crear evaluación, así el profe no tiene que reescribir el
//  cotidiano/tarea/prueba/proyecto cuando lo aplica a varios grupos.
// ─────────────────────────────────────────────────────────────────────────
router.get("/evaluaciones-copiables", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { asignacion_id, tipo, periodo } = req.query;
  if (!asignacion_id || !tipo) return res.status(400).json({ error: "asignacion_id y tipo requeridos" });
  try {
    const aR = await pool.query(
      `SELECT profesor_id, seccion_id, materia_id, subgrupo, periodo
       FROM asignaciones WHERE id = $1`, [asignacion_id]
    );
    if (!aR.rows.length) return res.status(404).json({ error: "Asignación no encontrada" });
    const a = aR.rows[0];
    if (u.rol !== "admin" && Number(a.profesor_id) !== Number(u.id)) return res.status(403).json({ error: "Solo el profesor a cargo o administración puede consultar estas evaluaciones." });

    // Buscar evaluaciones del mismo profe + misma materia + mismo tipo
    // pero de OTRAS asignaciones (secciones/subgrupos distintos).
    // Si viene ?periodo, se filtra solo a ese período (típico: profe copiando
    // dentro del mismo período lectivo — el de II no aplica al de I y viceversa).
    const params = [a.profesor_id, a.materia_id, tipo, a.seccion_id, a.subgrupo, a.periodo];
    let filtroPeriodo = "";
    if (periodo) {
      params.push(periodo);
      filtroPeriodo = ` AND e.periodo = $${params.length}`;
    }
    const r = await pool.query(`
      SELECT e.id, e.tipo, e.nombre, e.fecha, e.fecha_asignacion, e.puntaje_total,
        e.descripcion, e.valor_porcentual, e.periodo, e.subgrupo,
        s.nombre AS seccion_nombre,
        (SELECT COUNT(*) FROM indicadores i WHERE i.evaluacion_id = e.id) AS cant_indicadores
      FROM evaluaciones e
      JOIN secciones s ON s.id = e.seccion_id
      WHERE e.profesor_id = $1
        AND e.materia_id = $2
        AND e.tipo = $3
        AND NOT (e.seccion_id = $4 AND COALESCE(e.subgrupo,'') = COALESCE($5,'') AND e.periodo = $6)
        ${filtroPeriodo}
      ORDER BY e.periodo DESC, e.fecha DESC, s.nombre
      LIMIT 50
    `, params);
    res.json(r.rows);
  } catch (e) {
    console.error("GET evaluaciones-copiables:", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// Helper para archivado por "Aplicar Matrículas": calcula promedios sin validar
// sesión de profe (usa admin implícito). Devuelve la misma estructura que el
// endpoint público /promedio/seccion.
module.exports.calcularPromediosParaArchivo = async function(client, profesor_id, seccion_id, materia_id, subgrupo, periodo){
  try {
    return await calcularPromediosAsignacion(profesor_id, seccion_id, materia_id, subgrupo, periodo);
  } catch(e){
    // Si falla (sin regla REAC, sin evaluaciones, etc.), devolvemos null y el
    // proceso de archivo la salta. No debe romper el flujo completo.
    return null;
  }
};

// Reutilización institucional para el tablero de Rendimiento. Mantiene una
// sola fórmula oficial para docentes, actas y estadísticas administrativas.
module.exports.calcularPromediosInstitucional = calcularPromediosAsignacion;

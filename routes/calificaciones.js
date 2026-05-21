const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

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
        AND a.periodo = $2
        AND m.nombre NOT IN ('Guía','Orientación','Fortalecimiento Matemático')
      ORDER BY s.nombre, m.nombre, a.subgrupo NULLS FIRST
    `, [u.id, periodo]);

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
  const r = await pool.query(`
    SELECT a.id, m.nombre AS materia_nombre, s.nivel AS seccion_nivel,
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
      AND (($4::text IS NULL AND a.subgrupo IS NULL) OR a.subgrupo = $4)
      AND a.periodo     = $5
    LIMIT 1
  `, [profesor_id, seccion_id, materia_id, subgrupo || null, periodo]);
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

// ── CREAR evaluación ────────────────────────────────────────────────────
// Body para examen:        { tipo:'examen', nombre, descripcion?, fecha, puntaje_total, seccion_id, materia_id, subgrupo?, periodo }
// Body para tarea:         { tipo:'tarea', nombre, descripcion?, fecha_asignacion, fecha (entrega), seccion_id, materia_id, subgrupo?, periodo, indicadores: [...] }
// Body para cotid/proy:    { tipo:'cotidiano'|'proyecto', nombre, descripcion?, fecha, seccion_id, materia_id, subgrupo?, periodo, indicadores: [...] }
router.post("/evaluaciones", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { tipo, nombre, descripcion, fecha, fecha_asignacion, puntaje_total, indicadores,
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
    const ev = await client.query(`
      INSERT INTO evaluaciones (profesor_id, seccion_id, materia_id, subgrupo, periodo, tipo, nombre, descripcion, fecha, fecha_asignacion, puntaje_total)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [u.id, seccion_id, materia_id, subgrupo || null, periodo, tipo, nombre.trim(), descripcion || null, fecha, ((tipo === 'tarea' || tipo === 'proyecto') ? fecha_asignacion : null), pt]);
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
  const { nombre, descripcion, fecha, fecha_asignacion, puntaje_total } = req.body;
  if (!nombre || !fecha) return res.status(400).json({ error: "Faltan campos." });
  if (row.tipo === 'examen' && (!puntaje_total || Number(puntaje_total) <= 0)) {
    return res.status(400).json({ error: "El puntaje total debe ser mayor a 0." });
  }
  if (row.tipo === 'tarea' || row.tipo === 'proyecto') {
    if (!fecha_asignacion) return res.status(400).json({ error: "Falta la fecha de asignación." });
  }
  // Si cambia el puntaje del examen, las notas siguen siendo válidas
  // (puntos_obtenidos no cambia, solo se reinterpreta la proporción).
  const newPt = row.tipo === 'examen' ? Number(puntaje_total) : row.puntaje_total;
  const newFAsig = (row.tipo === 'tarea' || row.tipo === 'proyecto') ? fecha_asignacion : null;
  await pool.query(`
    UPDATE evaluaciones SET nombre=$1, descripcion=$2, fecha=$3, fecha_asignacion=$4, puntaje_total=$5, updated_at=NOW()
    WHERE id=$6
  `, [nombre.trim(), descripcion || null, fecha, newFAsig, newPt, row.id]);
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
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido, e.subgrupo
    FROM estudiantes e
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

// Fechas oficiales de cada período del año lectivo 2026 (centralizadas).
// Si cambian, modificar acá.
const PERIODOS_FECHAS = {
  'I Período':  { desde: '2026-02-23', hasta: '2026-07-03' },
  'II Período': { desde: '2026-07-20', hasta: '2026-12-09' }
};

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
    SELECT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido, e.subgrupo
    FROM estudiantes e
    WHERE e.seccion_id = $1 AND e.activo = true
      AND (($2::text IS NULL) OR e.subgrupo = $2)
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
  `, [seccion_id, sub]);
  const estudiantes = estudiantesR.rows;

  // 4. Cargar todas las evaluaciones del período para esta asignación, con sus notas
  const evalsR = await pool.query(`
    SELECT e.id, e.tipo, e.puntaje_total
    FROM evaluaciones e
    WHERE e.profesor_id = $1 AND e.seccion_id = $2 AND e.materia_id = $3
      AND (($4::text IS NULL AND e.subgrupo IS NULL) OR e.subgrupo=$4)
      AND e.periodo = $5
  `, [profesor_id, seccion_id, materia_id, sub, periodo]);

  // Para cada estudiante, acumuladores por tipo
  // tipo → { obtenido_total: número, max_total: número, cant_evals: número }
  const rubros = new Map(); // estudiante_id → { examen: {...}, tarea: {...}, ... }
  estudiantes.forEach(e => {
    rubros.set(e.id, {
      examen:    { obtenido: 0, max: 0, cant_evals: 0, cant_con_nota: 0 },
      tarea:     { obtenido: 0, max: 0, cant_evals: 0, cant_con_nota: 0 },
      cotidiano: { obtenido: 0, max: 0, cant_evals: 0, cant_con_nota: 0 },
      proyecto:  { obtenido: 0, max: 0, cant_evals: 0, cant_con_nota: 0 }
    });
  });

  // Cargar notas por cada evaluación
  for (const ev of evalsR.rows) {
    if (ev.tipo === 'examen') {
      const ntx = await pool.query("SELECT estudiante_id, puntos_obtenidos FROM notas_examen WHERE evaluacion_id=$1", [ev.id]);
      const notasMap = new Map(ntx.rows.map(n => [Number(n.estudiante_id), Number(n.puntos_obtenidos)]));
      for (const e of estudiantes) {
        const r = rubros.get(e.id).examen;
        r.cant_evals += 1;
        r.max += Number(ev.puntaje_total);
        if (notasMap.has(e.id) && notasMap.get(e.id) != null && !isNaN(notasMap.get(e.id))) {
          r.obtenido += notasMap.get(e.id);
          r.cant_con_nota += 1;
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
  const fechas = PERIODOS_FECHAS[periodo];
  if (!fechas) throw new Error('Período inválido.');
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
    const pctExm   = notaExm !== null   ? (notaExm   * pesos.pruebas) / 100   : 0;
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

module.exports = router;

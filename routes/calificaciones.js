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
        AND m.nombre NOT IN ('Guía','Orientación')
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
    res.json({ asignacion: asig, evaluaciones: r.rows });
  } catch (e) {
    console.error("evaluaciones GET:", e);
    res.status(500).json({ error: "Error al cargar evaluaciones." });
  }
});

// ── CREAR evaluación ────────────────────────────────────────────────────
// Body para examen:        { tipo:'examen', nombre, descripcion?, fecha, puntaje_total, seccion_id, materia_id, subgrupo?, periodo }
// Body para los demás:     { tipo:'tarea'|'cotidiano'|'proyecto', nombre, descripcion?, fecha, seccion_id, materia_id, subgrupo?, periodo,
//                            indicadores: [{descripcion, puntaje_maximo}, ...] }
router.post("/evaluaciones", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { tipo, nombre, descripcion, fecha, puntaje_total, indicadores,
          seccion_id, materia_id, subgrupo, periodo } = req.body;

  // Validaciones de campos básicos
  if (!tipo || !nombre || !fecha) return res.status(400).json({ error: "Faltan campos obligatorios." });
  if (!['examen','tarea','cotidiano','proyecto'].includes(tipo)) return res.status(400).json({ error: "Tipo inválido." });
  if (!seccion_id || !materia_id || !periodo) return res.status(400).json({ error: "Faltan datos de asignación." });

  // Verificar asignación
  const asig = await verificarAsignacion(u.id, seccion_id, materia_id, subgrupo, periodo);
  if (!asig) return res.status(403).json({ error: "Sin acceso a esta asignación." });

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
      INSERT INTO evaluaciones (profesor_id, seccion_id, materia_id, subgrupo, periodo, tipo, nombre, descripcion, fecha, puntaje_total)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [u.id, seccion_id, materia_id, subgrupo || null, periodo, tipo, nombre.trim(), descripcion || null, fecha, pt]);
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
  const { nombre, descripcion, fecha, puntaje_total } = req.body;
  if (!nombre || !fecha) return res.status(400).json({ error: "Faltan campos." });
  if (row.tipo === 'examen' && (!puntaje_total || Number(puntaje_total) <= 0)) {
    return res.status(400).json({ error: "El puntaje total debe ser mayor a 0." });
  }
  // Si cambia el puntaje del examen, las notas siguen siendo válidas
  // (puntos_obtenidos no cambia, solo se reinterpreta la proporción).
  const newPt = row.tipo === 'examen' ? Number(puntaje_total) : row.puntaje_total;
  await pool.query(`
    UPDATE evaluaciones SET nombre=$1, descripcion=$2, fecha=$3, puntaje_total=$4, updated_at=NOW()
    WHERE id=$5
  `, [nombre.trim(), descripcion || null, fecha, newPt, row.id]);
  res.json({ ok: true });
});

// ── ELIMINAR evaluación (cascada: indicadores y notas se borran) ───────
router.delete("/evaluaciones/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { row, err, msg } = await getEvaluacionMia(u, req.params.id);
  if (err) return res.status(err).json({ error: msg });
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

module.exports = router;

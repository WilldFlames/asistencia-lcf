// ════════════════════════════════════════════════════════════════════════
// DEBIDOS PROCESOS — Procedimiento correctivo según REAC art. 144
// ════════════════════════════════════════════════════════════════════════
//
// Flujo:
//  Paso 1  acta_apertura       — cualquier profesor puede iniciar
//  Paso 2  cita_ofendido        — boleta cita al encargado del supuesto ofendido
//  Paso 3  decl_ofendido        — declaración del supuesto ofendido
//  Paso 4  cita_ofensor         — boleta cita al encargado del supuesto ofensor
//  Paso 5  decl_ofensor         — declaración del supuesto ofensor
//  Paso 6  cita_testigo         — boleta cita al encargado de cada testigo (N veces)
//  Paso 7  decl_testigo         — declaración de cada testigo (N veces)
//  Paso 8  acta_sesion          — acta sesión docente-orientador con decisión:
//                                  'continuar'  -> paso 9 y 10
//                                  'desestimar' -> paso 11 (desestima)
//  Paso 9  traslado_cargos
//  Paso 10 resolucion_final
//  Paso 11 desestima             — alternativa al 9 y 10 si se desestima
//
// Permisos:
//  - acta_apertura: cualquier profesor
//  - resto de pasos: profesor_guia de la sección del ofensor
//  - declaraciones/citas de testigos en otra sección: se asignan al guía
//    de esa sección, quien las completa; luego el guía del proceso verifica
//  - aprobación acta_sesion / resolucion_final: orientador asignado a la
//    sección del estudiante ofensor
//
// El estado del proceso refleja en qué paso va:
//  - 'en_curso'    — se están registrando pasos
//  - 'desestimado' — cerrado tras paso 8 con decision='desestimar'
//  - 'resuelto'    — cerrado tras paso 10 (resolución final)

const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth, requireRol } = require("../middleware/auth");
const { asignarConsecutivoInterno } = require("./consecutivos");

// Roles que pueden iniciar un acta de apertura (cualquier docente/admin)
const ROLES_INICIAR = ["admin","auxiliar","profesor","profesor_guia","orientador","secretaria","administrativo"];
// Roles que pueden ver listados completos (todos los profes pueden ver los suyos)
const ROLES_VER = [...ROLES_INICIAR];

// Helper: obtiene el guía de una sección, o null si no tiene
async function getGuiaDeSeccion(seccionId) {
  if (!seccionId) return null;
  const r = await pool.query(
    "SELECT profesor_id FROM seccion_guia WHERE seccion_id=$1 LIMIT 1",
    [seccionId]
  );
  return r.rows[0]?.profesor_id || null;
}

// Helper: obtiene el orientador de una sección
async function getOrientadorDeSeccion(seccionId) {
  if (!seccionId) return null;
  const r = await pool.query(
    "SELECT orientador_id FROM seccion_orientador WHERE seccion_id=$1 LIMIT 1",
    [seccionId]
  );
  return r.rows[0]?.orientador_id || null;
}

// Helper: crear una notificación
async function notificar(usuarioId, tipo, mensaje) {
  if (!usuarioId) return;
  try {
    await pool.query(
      "INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1,$2,$3)",
      [usuarioId, tipo, mensaje]
    );
  } catch (e) {
    console.error("Notif DP:", e.message);
  }
}

// ── LISTAR PROCESOS ───────────────────────────────────────────────────
// Devuelve los procesos filtrados según rol:
// - admin/auxiliar/administrativo: todos
// - profesor_guia: los de su sección o donde es guía a cargo
// - profesor común: solo los donde figura como iniciado_por o asignado a un paso
router.get("/", requireAuth, async (req, res) => {
  try {
    const u = req.session.usuario;
    const { estado } = req.query;

    let where = [];
    let params = [];
    if (estado) {
      params.push(estado);
      where.push(`dp.estado = $${params.length}`);
    }

    // Filtros por rol
    const esStaff = ["admin","auxiliar","administrativo","secretaria"].includes(u.rol);
    if (!esStaff) {
      // Profesor/guía/orientador: solo ven sus propios procesos relacionados
      params.push(u.id);
      const iU = params.length;
      where.push(`(
        dp.iniciado_por = $${iU}
        OR dp.guia_a_cargo = $${iU}
        OR dp.orientador_id = $${iU}
        OR EXISTS (SELECT 1 FROM dp_pasos pp WHERE pp.proceso_id=dp.id AND pp.asignado_a = $${iU})
      )`);
    }

    const sql = `
      SELECT dp.id, dp.numero, dp.anio, dp.estado, dp.decision_sesion, dp.created_at, dp.updated_at,
             e.id AS est_id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
             s.id AS seccion_id, s.nombre AS seccion_nombre,
             g.primer_apellido AS guia_ap1, g.segundo_apellido AS guia_ap2, g.nombre AS guia_nombre,
             o.primer_apellido AS orient_ap1, o.segundo_apellido AS orient_ap2, o.nombre AS orient_nombre,
             ini.primer_apellido AS ini_ap1, ini.segundo_apellido AS ini_ap2, ini.nombre AS ini_nombre,
             (SELECT COUNT(*) FROM dp_pasos pp WHERE pp.proceso_id=dp.id AND pp.completado=true)::int AS pasos_completados,
             (SELECT COUNT(*) FROM dp_pasos pp WHERE pp.proceso_id=dp.id)::int AS pasos_totales
      FROM debidos_procesos dp
      JOIN estudiantes e ON e.id = dp.estudiante_id
      LEFT JOIN secciones s ON s.id = e.seccion_id
      LEFT JOIN usuarios g ON g.id = dp.guia_a_cargo
      LEFT JOIN usuarios o ON o.id = dp.orientador_id
      LEFT JOIN usuarios ini ON ini.id = dp.iniciado_por
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY dp.updated_at DESC, dp.id DESC
    `;
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    console.error("GET /api/debidos-procesos error:", e);
    // Si la tabla no existe, devolver lista vacía con mensaje en lugar de crashear
    if (e.code === '42P01' || e.message?.includes('does not exist')) {
      return res.json([]);
    }
    res.status(500).json({ error: e.message });
  }
});

// ── PROCESOS PENDIENTES DE OTROS PROFESORES (declaraciones por tomar) ─
// ⚠ Estos endpoints van ANTES de /:id porque si no, Express interpreta
// "/pendientes/mios" como "/:id" con id="pendientes".
router.get("/pendientes/mios", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const r = await pool.query(`
    SELECT dp.id AS proceso_id, dp.numero, dp.anio,
           pp.id AS paso_id, pp.tipo, pp.orden, pp.completado,
           e.primer_apellido, e.segundo_apellido, e.nombre, e.cedula,
           s.nombre AS seccion_nombre
    FROM dp_pasos pp
    JOIN debidos_procesos dp ON dp.id = pp.proceso_id
    JOIN estudiantes e ON e.id = dp.estudiante_id
    LEFT JOIN secciones s ON s.id = e.seccion_id
    WHERE pp.asignado_a = $1 AND dp.estado = 'en_curso' AND pp.completado = false
    ORDER BY dp.created_at DESC
  `, [u.id]);
  res.json(r.rows);
});

// ── PROCESOS PENDIENTES DEL ORIENTADOR ────────────────────────────────
router.get("/pendientes/orientador", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const r = await pool.query(`
    SELECT dp.id AS proceso_id, dp.numero, dp.anio, dp.decision_sesion,
           e.primer_apellido, e.segundo_apellido, e.nombre, e.cedula,
           s.nombre AS seccion_nombre
    FROM debidos_procesos dp
    JOIN estudiantes e ON e.id = dp.estudiante_id
    LEFT JOIN secciones s ON s.id = e.seccion_id
    WHERE dp.orientador_id = $1
      AND dp.decision_sesion IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM dp_aprobaciones_orientador a
        WHERE a.proceso_id = dp.id AND a.orientador_id = $1
      )
      AND dp.estado = 'en_curso'
    ORDER BY dp.updated_at DESC
  `, [u.id]);
  res.json(r.rows);
});

// ── DETALLE DE UN PROCESO ─────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  const dpR = await pool.query(`
    SELECT dp.*, e.cedula, e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
           e.seccion_id, s.nombre AS seccion_nombre,
           g.nombre AS guia_nombre, g.primer_apellido AS guia_ap1, g.segundo_apellido AS guia_ap2, g.cedula AS guia_cedula,
           o.nombre AS orient_nombre, o.primer_apellido AS orient_ap1, o.segundo_apellido AS orient_ap2, o.cedula AS orient_cedula,
           ini.nombre AS ini_nombre, ini.primer_apellido AS ini_ap1, ini.segundo_apellido AS ini_ap2
    FROM debidos_procesos dp
    JOIN estudiantes e ON e.id = dp.estudiante_id
    LEFT JOIN secciones s ON s.id = e.seccion_id
    LEFT JOIN usuarios g ON g.id = dp.guia_a_cargo
    LEFT JOIN usuarios o ON o.id = dp.orientador_id
    LEFT JOIN usuarios ini ON ini.id = dp.iniciado_por
    WHERE dp.id = $1
  `, [req.params.id]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];

  // Pasos
  const pasosR = await pool.query(`
    SELECT pp.*, u1.primer_apellido AS comp_ap1, u1.segundo_apellido AS comp_ap2, u1.nombre AS comp_nombre,
           u2.primer_apellido AS verif_ap1, u2.segundo_apellido AS verif_ap2, u2.nombre AS verif_nombre,
           u3.primer_apellido AS asig_ap1, u3.segundo_apellido AS asig_ap2, u3.nombre AS asig_nombre, u3.id AS asig_id
    FROM dp_pasos pp
    LEFT JOIN usuarios u1 ON u1.id = pp.completado_por
    LEFT JOIN usuarios u2 ON u2.id = pp.verificado_por
    LEFT JOIN usuarios u3 ON u3.id = pp.asignado_a
    WHERE pp.proceso_id = $1
    ORDER BY pp.orden, pp.id
  `, [req.params.id]);

  // Testigos
  const testR = await pool.query(`
    SELECT t.id, t.estudiante_id, t.paso_cita_id, t.paso_decl_id,
           e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
           s.nombre AS seccion_nombre, s.id AS seccion_id
    FROM dp_testigos t
    JOIN estudiantes e ON e.id = t.estudiante_id
    LEFT JOIN secciones s ON s.id = e.seccion_id
    WHERE t.proceso_id = $1
    ORDER BY t.id
  `, [req.params.id]);

  // Aprobaciones del orientador
  const aprobR = await pool.query(`
    SELECT a.*, u.primer_apellido AS orient_ap1, u.segundo_apellido AS orient_ap2, u.nombre AS orient_nombre
    FROM dp_aprobaciones_orientador a
    LEFT JOIN usuarios u ON u.id = a.orientador_id
    WHERE a.proceso_id = $1
    ORDER BY a.fecha DESC
  `, [req.params.id]);

  res.json({
    proceso: dp,
    pasos: pasosR.rows,
    testigos: testR.rows,
    aprobaciones: aprobR.rows
  });
});

// ── INICIAR PROCESO + PASO 1 (acta de apertura) ───────────────────────
// Cualquier profesor puede crear el proceso. Se asigna automáticamente:
//  - consecutivo tipo 'proceso'
//  - guia_a_cargo = guía de la sección del estudiante
//  - orientador_id = orientador de esa sección
router.post("/", requireRol(...ROLES_INICIAR), async (req, res) => {
  const u = req.session.usuario;
  const { estudiante_id, contenido_apertura } = req.body;
  if (!estudiante_id) return res.status(400).json({ error: "Falta estudiante_id" });

  const estR = await pool.query("SELECT id, seccion_id FROM estudiantes WHERE id=$1 AND activo=true", [estudiante_id]);
  if (!estR.rows.length) return res.status(404).json({ error: "Estudiante no encontrado o no activo" });
  const est = estR.rows[0];

  const guiaId = await getGuiaDeSeccion(est.seccion_id);
  const orientId = await getOrientadorDeSeccion(est.seccion_id);
  const anio = new Date().getFullYear();

  // Asignar consecutivo tipo 'proceso'
  let consec;
  try {
    consec = await asignarConsecutivoInterno("proceso", u.id, {
      estudiante_id,
      seccion_id: est.seccion_id,
      motivo_proceso: "Debido proceso disciplinario"
    });
  } catch (e) {
    return res.status(400).json({ error: "No se pudo asignar consecutivo: " + e.message });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Crear el proceso
    const dpR = await client.query(`
      INSERT INTO debidos_procesos
        (consecutivo_id, numero, anio, estudiante_id, iniciado_por, guia_a_cargo, orientador_id, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'en_curso')
      RETURNING id, numero, anio
    `, [consec.id, consec.numero, anio, estudiante_id, u.id, guiaId, orientId]);
    const procesoId = dpR.rows[0].id;

    // Crear el Paso 1 (acta apertura) ya completado con el contenido enviado
    await client.query(`
      INSERT INTO dp_pasos (proceso_id, tipo, orden, completado, completado_por, completado_en, contenido)
      VALUES ($1, 'acta_apertura', 1, true, $2, NOW(), $3::jsonb)
    `, [procesoId, u.id, JSON.stringify(contenido_apertura || {})]);

    await client.query("COMMIT");

    // Notificar al guía si NO es quien inició
    if (guiaId && guiaId !== u.id) {
      await notificar(guiaId, "debido_proceso",
        `📋 Se inició un debido proceso (N°${consec.numero}-${anio}) que te toca continuar como guía de la sección.`);
    }

    res.json({ ok: true, id: procesoId, numero: consec.numero, anio });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Crear DP:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── CREAR / ACTUALIZAR UN PASO ────────────────────────────────────────
// El cliente envía: { tipo, contenido, completar }
// Si el paso aún no existe (por tipo+orden), se crea. Si ya existe, se
// actualiza el contenido.
router.post("/:id/pasos", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const procesoId = req.params.id;
  const { tipo, orden, contenido, completar, testigo_id } = req.body;
  if (!tipo) return res.status(400).json({ error: "Falta tipo" });

  // Validar permisos: el guía del proceso, admin o el asignado pueden modificar
  const dpR = await pool.query("SELECT * FROM debidos_procesos WHERE id=$1", [procesoId]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];

  if (dp.estado !== "en_curso") {
    return res.status(423).json({ error: `Este proceso está ${dp.estado}; no se pueden modificar pasos.` });
  }

  const esStaff = ["admin","administrativo","auxiliar"].includes(u.rol);
  const esGuiaProceso = dp.guia_a_cargo === u.id;
  const esIniciador = dp.iniciado_por === u.id && tipo === "acta_apertura";

  // Para pasos asignados a otro profe (declaración de testigo en otra sección)
  // verificamos si u.id es el asignado
  let esAsignado = false;
  if (orden) {
    const pR = await pool.query(
      "SELECT asignado_a FROM dp_pasos WHERE proceso_id=$1 AND tipo=$2 AND orden=$3",
      [procesoId, tipo, orden]
    );
    if (pR.rows.length && pR.rows[0].asignado_a === u.id) esAsignado = true;
  }

  if (!esStaff && !esGuiaProceso && !esIniciador && !esAsignado) {
    return res.status(403).json({ error: "Sin permisos para modificar este paso" });
  }

  // Crear o actualizar
  const ordenFinal = orden || 1;
  const existente = await pool.query(
    "SELECT id FROM dp_pasos WHERE proceso_id=$1 AND tipo=$2 AND orden=$3",
    [procesoId, tipo, ordenFinal]
  );

  let pasoId;
  if (existente.rows.length) {
    pasoId = existente.rows[0].id;
    const setComp = completar
      ? ", completado=true, completado_por=$4, completado_en=NOW()"
      : "";
    const params = completar
      ? [JSON.stringify(contenido || {}), procesoId, pasoId, u.id]
      : [JSON.stringify(contenido || {}), procesoId, pasoId];
    await pool.query(
      `UPDATE dp_pasos SET contenido=$1::jsonb, updated_at=NOW()${setComp}
       WHERE proceso_id=$2 AND id=$3`,
      params
    );
  } else {
    const ins = await pool.query(`
      INSERT INTO dp_pasos (proceso_id, tipo, orden, completado, completado_por, completado_en, contenido)
      VALUES ($1, $2, $3, $4, $5, ${completar ? "NOW()" : "NULL"}, $6::jsonb)
      RETURNING id
    `, [procesoId, tipo, ordenFinal, !!completar, completar ? u.id : null, JSON.stringify(contenido || {})]);
    pasoId = ins.rows[0].id;
  }

  // Actualizar marca de tiempo del proceso
  await pool.query("UPDATE debidos_procesos SET updated_at=NOW() WHERE id=$1", [procesoId]);

  res.json({ ok: true, paso_id: pasoId });
});

// ── AGREGAR TESTIGO ───────────────────────────────────────────────────
// Crea automáticamente los pasos 6 (cita) y 7 (declaración) para ese testigo.
// Si el testigo es de OTRA sección, los pasos se asignan al guía de esa sección.
router.post("/:id/testigos", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const procesoId = req.params.id;
  const { estudiante_id } = req.body;
  if (!estudiante_id) return res.status(400).json({ error: "Falta estudiante_id del testigo" });

  const dpR = await pool.query("SELECT * FROM debidos_procesos WHERE id=$1", [procesoId]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];

  const esStaff = ["admin","administrativo","auxiliar"].includes(u.rol);
  if (!esStaff && dp.guia_a_cargo !== u.id) {
    return res.status(403).json({ error: "Solo el guía del proceso puede agregar testigos." });
  }

  // No duplicar testigos
  const dup = await pool.query("SELECT id FROM dp_testigos WHERE proceso_id=$1 AND estudiante_id=$2", [procesoId, estudiante_id]);
  if (dup.rows.length) return res.status(409).json({ error: "Ese estudiante ya está agregado como testigo." });

  const estR = await pool.query("SELECT id, seccion_id, primer_apellido, nombre FROM estudiantes WHERE id=$1 AND activo=true", [estudiante_id]);
  if (!estR.rows.length) return res.status(404).json({ error: "Estudiante testigo no encontrado o no activo" });
  const est = estR.rows[0];

  // Determinar si es de otra sección
  const guiaTestigo = await getGuiaDeSeccion(est.seccion_id);
  const esOtraSeccion = guiaTestigo && guiaTestigo !== dp.guia_a_cargo;
  const asignadoA = esOtraSeccion ? guiaTestigo : null;

  // Calcular el orden secuencial (1, 2, 3...) basado en cuántos testigos hay
  const cont = await pool.query("SELECT COUNT(*)::int AS n FROM dp_testigos WHERE proceso_id=$1", [procesoId]);
  const ordenTestigo = cont.rows[0].n + 1;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Crear paso cita_testigo
    const citaR = await client.query(`
      INSERT INTO dp_pasos (proceso_id, tipo, orden, asignado_a, contenido)
      VALUES ($1, 'cita_testigo', $2, $3, $4::jsonb) RETURNING id
    `, [procesoId, ordenTestigo, asignadoA, JSON.stringify({ testigo_estudiante_id: estudiante_id })]);
    // Crear paso decl_testigo
    const declR = await client.query(`
      INSERT INTO dp_pasos (proceso_id, tipo, orden, asignado_a, contenido)
      VALUES ($1, 'decl_testigo', $2, $3, $4::jsonb) RETURNING id
    `, [procesoId, ordenTestigo, asignadoA, JSON.stringify({ testigo_estudiante_id: estudiante_id })]);
    // Crear registro de testigo
    await client.query(`
      INSERT INTO dp_testigos (proceso_id, estudiante_id, paso_cita_id, paso_decl_id)
      VALUES ($1, $2, $3, $4)
    `, [procesoId, estudiante_id, citaR.rows[0].id, declR.rows[0].id]);
    await client.query("UPDATE debidos_procesos SET updated_at=NOW() WHERE id=$1", [procesoId]);
    await client.query("COMMIT");

    // Notificar al guía de la otra sección
    if (asignadoA) {
      await notificar(asignadoA, "debido_proceso_pendiente",
        `📋 Tenés una declaración de testigo pendiente en el debido proceso N°${dp.numero}-${dp.anio} (testigo: ${est.primer_apellido} ${est.nombre}).`);
    }

    res.json({ ok: true, paso_cita_id: citaR.rows[0].id, paso_decl_id: declR.rows[0].id, asignado_a: asignadoA });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Agregar testigo:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── ELIMINAR TESTIGO ──────────────────────────────────────────────────
router.delete("/:id/testigos/:testigo_id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const procesoId = req.params.id;
  const dpR = await pool.query("SELECT * FROM debidos_procesos WHERE id=$1", [procesoId]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];

  const esStaff = ["admin","administrativo","auxiliar"].includes(u.rol);
  if (!esStaff && dp.guia_a_cargo !== u.id) {
    return res.status(403).json({ error: "Sin permisos" });
  }

  // Borrar los pasos asociados (los borra en cascada por la FK pero por claridad)
  const t = await pool.query("SELECT paso_cita_id, paso_decl_id FROM dp_testigos WHERE id=$1 AND proceso_id=$2", [req.params.testigo_id, procesoId]);
  if (t.rows.length) {
    if (t.rows[0].paso_cita_id) await pool.query("DELETE FROM dp_pasos WHERE id=$1", [t.rows[0].paso_cita_id]);
    if (t.rows[0].paso_decl_id) await pool.query("DELETE FROM dp_pasos WHERE id=$1", [t.rows[0].paso_decl_id]);
  }
  await pool.query("DELETE FROM dp_testigos WHERE id=$1", [req.params.testigo_id]);
  res.json({ ok: true });
});

// ── VERIFICAR PASO (check del guía cuando lo hizo otro profe) ─────────
router.post("/:id/pasos/:paso_id/verificar", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const dpR = await pool.query("SELECT * FROM debidos_procesos WHERE id=$1", [req.params.id]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];
  const esStaff = ["admin","administrativo","auxiliar"].includes(u.rol);
  if (!esStaff && dp.guia_a_cargo !== u.id) {
    return res.status(403).json({ error: "Solo el guía a cargo puede verificar." });
  }
  await pool.query(
    "UPDATE dp_pasos SET verificado=true, verificado_por=$1, verificado_en=NOW() WHERE id=$2 AND proceso_id=$3",
    [u.id, req.params.paso_id, req.params.id]
  );
  res.json({ ok: true });
});

// ── DECIDIR EN PASO 8 (continuar / desestimar) ────────────────────────
// El guía registra la decisión. Queda pendiente de aprobación del orientador.
router.post("/:id/decidir-sesion", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { decision, contenido } = req.body;
  if (!["continuar","desestimar"].includes(decision)) {
    return res.status(400).json({ error: "decision inválida (debe ser 'continuar' o 'desestimar')" });
  }
  const dpR = await pool.query("SELECT * FROM debidos_procesos WHERE id=$1", [req.params.id]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];

  const esStaff = ["admin","administrativo","auxiliar"].includes(u.rol);
  if (!esStaff && dp.guia_a_cargo !== u.id) {
    return res.status(403).json({ error: "Solo el guía a cargo puede registrar esta decisión." });
  }
  if (dp.estado !== "en_curso") {
    return res.status(423).json({ error: "El proceso no está en curso." });
  }

  // Guardar/actualizar acta_sesion
  const contJson = { ...(contenido || {}), decision };
  const exist = await pool.query(
    "SELECT id FROM dp_pasos WHERE proceso_id=$1 AND tipo='acta_sesion'",
    [req.params.id]
  );
  let pasoId;
  if (exist.rows.length) {
    pasoId = exist.rows[0].id;
    await pool.query(`
      UPDATE dp_pasos SET contenido=$1::jsonb, completado=true,
        completado_por=$2, completado_en=NOW(), updated_at=NOW()
      WHERE id=$3
    `, [JSON.stringify(contJson), u.id, pasoId]);
  } else {
    const ins = await pool.query(`
      INSERT INTO dp_pasos (proceso_id, tipo, orden, completado, completado_por, completado_en, contenido)
      VALUES ($1, 'acta_sesion', 8, true, $2, NOW(), $3::jsonb) RETURNING id
    `, [req.params.id, u.id, JSON.stringify(contJson)]);
    pasoId = ins.rows[0].id;
  }

  // Actualizar decision_sesion en el proceso (queda pendiente de aprobación)
  await pool.query("UPDATE debidos_procesos SET decision_sesion=$1, updated_at=NOW() WHERE id=$2", [decision, req.params.id]);

  // Notificar al orientador para que apruebe
  if (dp.orientador_id) {
    await notificar(dp.orientador_id, "debido_proceso_aprobacion",
      `📋 Tenés una decisión de acta sesión pendiente de aprobar en el debido proceso N°${dp.numero}-${dp.anio}. Decisión propuesta: ${decision}.`);
  }

  res.json({ ok: true, paso_id: pasoId });
});

// ── APROBAR / RECHAZAR ACTA SESIÓN (orientador) ───────────────────────
router.post("/:id/aprobar-sesion", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { decision, observacion } = req.body;  // decision: 'aprobado' | 'rechazado'
  if (!["aprobado","rechazado"].includes(decision)) {
    return res.status(400).json({ error: "decision inválida" });
  }
  const dpR = await pool.query("SELECT * FROM debidos_procesos WHERE id=$1", [req.params.id]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];

  const esAdmin = ["admin","administrativo"].includes(u.rol);
  if (!esAdmin && dp.orientador_id !== u.id) {
    return res.status(403).json({ error: "Solo el orientador asignado puede aprobar." });
  }
  if (!dp.decision_sesion) {
    return res.status(400).json({ error: "Aún no hay decisión propuesta para aprobar." });
  }

  const pasoR = await pool.query("SELECT id FROM dp_pasos WHERE proceso_id=$1 AND tipo='acta_sesion'", [req.params.id]);
  if (!pasoR.rows.length) return res.status(400).json({ error: "Acta sesión no existe." });
  const pasoId = pasoR.rows[0].id;

  await pool.query(`
    INSERT INTO dp_aprobaciones_orientador (proceso_id, paso_id, orientador_id, decision, observacion)
    VALUES ($1,$2,$3,$4,$5)
  `, [req.params.id, pasoId, u.id, decision, observacion || null]);

  // Si aprobó y decisión = desestimar, cerrar el proceso
  if (decision === "aprobado" && dp.decision_sesion === "desestimar") {
    // Crear paso desestima en blanco para que el guía lo complete
    const existD = await pool.query("SELECT id FROM dp_pasos WHERE proceso_id=$1 AND tipo='desestima'", [req.params.id]);
    if (!existD.rows.length) {
      await pool.query(`
        INSERT INTO dp_pasos (proceso_id, tipo, orden, contenido)
        VALUES ($1, 'desestima', 11, '{}'::jsonb)
      `, [req.params.id]);
    }
    // El estado pasa a 'desestimado' al completar el paso desestima (no acá)
  } else if (decision === "aprobado" && dp.decision_sesion === "continuar") {
    // Crear pasos 9 y 10 en blanco
    for (const [tipo, orden] of [["traslado_cargos", 9], ["resolucion_final", 10]]) {
      const ex = await pool.query("SELECT id FROM dp_pasos WHERE proceso_id=$1 AND tipo=$2", [req.params.id, tipo]);
      if (!ex.rows.length) {
        await pool.query(`
          INSERT INTO dp_pasos (proceso_id, tipo, orden, contenido) VALUES ($1, $2, $3, '{}'::jsonb)
        `, [req.params.id, tipo, orden]);
      }
    }
  }

  // Notificar al guía del proceso
  await notificar(dp.guia_a_cargo, "debido_proceso",
    `📋 El orientador ${decision === "aprobado" ? "aprobó" : "rechazó"} el acta sesión del debido proceso N°${dp.numero}-${dp.anio}. ${observacion ? "Observación: " + observacion : ""}`);

  await pool.query("UPDATE debidos_procesos SET updated_at=NOW() WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── CERRAR PROCESO (al completar resolución final o desestima) ────────
router.post("/:id/cerrar", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const dpR = await pool.query("SELECT * FROM debidos_procesos WHERE id=$1", [req.params.id]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];

  const esStaff = ["admin","administrativo","auxiliar"].includes(u.rol);
  if (!esStaff && dp.guia_a_cargo !== u.id) {
    return res.status(403).json({ error: "Sin permisos" });
  }

  let nuevoEstado;
  if (dp.decision_sesion === "desestimar") {
    nuevoEstado = "desestimado";
  } else if (dp.decision_sesion === "continuar") {
    nuevoEstado = "resuelto";
  } else {
    return res.status(400).json({ error: "Debe completarse el acta sesión antes de cerrar." });
  }
  await pool.query("UPDATE debidos_procesos SET estado=$1, updated_at=NOW() WHERE id=$2", [nuevoEstado, req.params.id]);
  res.json({ ok: true, estado: nuevoEstado });
});

// ── ELIMINAR un proceso completo (solo admin/administrativo) ──────────
// Borra el proceso, sus pasos, testigos, aprobaciones e historial. Además
// libera el consecutivo asociado para que pueda ser reutilizado por otro
// proceso. Es IRREVERSIBLE — pensada para limpiar registros de prueba.
router.delete("/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if (!["admin","administrativo"].includes(u.rol)) {
    return res.status(403).json({ error: "Solo administración puede eliminar procesos." });
  }
  const dpR = await pool.query("SELECT id, consecutivo_id, numero, anio FROM debidos_procesos WHERE id=$1", [req.params.id]);
  if (!dpR.rows.length) return res.status(404).json({ error: "Proceso no encontrado" });
  const dp = dpR.rows[0];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Borrar dependientes (las FK tienen ON DELETE CASCADE pero por seguridad
    // los borramos explícitamente en orden).
    await client.query("DELETE FROM dp_historial_cambios WHERE proceso_id=$1", [dp.id]);
    await client.query("DELETE FROM dp_aprobaciones_orientador WHERE proceso_id=$1", [dp.id]);
    await client.query("DELETE FROM dp_testigos WHERE proceso_id=$1", [dp.id]);
    await client.query("DELETE FROM dp_pasos WHERE proceso_id=$1", [dp.id]);
    await client.query("DELETE FROM debidos_procesos WHERE id=$1", [dp.id]);
    // Liberar el consecutivo asociado
    if (dp.consecutivo_id) {
      await client.query("DELETE FROM consecutivos WHERE id=$1", [dp.consecutivo_id]);
    }
    await client.query("COMMIT");
    res.json({ ok: true, consecutivo_liberado: dp.numero, anio: dp.anio });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("DELETE debido proceso:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;

const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { requireRol, requireAuth } = require("../middleware/auth");
const onlyAdmin = requireRol("admin");

// ── USUARIOS ──────────────────────────────────────────────────
router.get("/usuarios", onlyAdmin, async (req, res) => {
  const r = await pool.query(
    "SELECT id,cedula,nombre,primer_apellido,segundo_apellido,email,rol,activo,primer_login FROM usuarios ORDER BY primer_apellido,nombre"
  );
  res.json(r.rows);
});

// Lista de usuarios activos — accesible para secretaria (para consecutivos)
router.get("/usuarios-activos", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT id,nombre,primer_apellido,segundo_apellido,rol FROM usuarios WHERE activo=true ORDER BY primer_apellido,nombre"
  );
  res.json(r.rows);
});

router.post("/usuarios", onlyAdmin, async (req, res) => {
  const { cedula, nombre, primer_apellido, segundo_apellido, email, rol } = req.body;
  if (!cedula||!nombre||!primer_apellido||!segundo_apellido||!rol)
    return res.status(400).json({ error: "Todos los campos son requeridos" });
  try {
    // Contraseña inicial = cédula, primer_login = true
    const hash = await bcrypt.hash(cedula.trim(), 10);
    const r = await pool.query(`
      INSERT INTO usuarios (cedula,nombre,primer_apellido,segundo_apellido,email,password_hash,rol,primer_login)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id
    `, [cedula.trim(),nombre.trim(),primer_apellido.trim(),segundo_apellido.trim(),email||null,hash,rol]);
    res.json({ ok:true, id:r.rows[0].id });
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "La cédula ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/usuarios/:id", onlyAdmin, async (req, res) => {
  const { nombre, primer_apellido, segundo_apellido, email, rol, activo } = req.body;
  try {
    await pool.query(`UPDATE usuarios SET nombre=$1,primer_apellido=$2,segundo_apellido=$3,email=$4,rol=$5,activo=$6 WHERE id=$7`,
      [nombre,primer_apellido,segundo_apellido,email||null,rol,activo,req.params.id]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Reiniciar contraseña → vuelve a ser la cédula, obliga cambio
router.put("/usuarios/:id/reset-password", onlyAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT cedula FROM usuarios WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    const hash = await bcrypt.hash(r.rows[0].cedula, 10);
    await pool.query("UPDATE usuarios SET password_hash=$1, primer_login=true WHERE id=$2", [hash, req.params.id]);
    res.json({ ok: true, mensaje: "Contraseña reiniciada. El usuario deberá cambiarla al ingresar." });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MATERIAS ──────────────────────────────────────────────────
router.get("/materias", async (req, res) => {
  const r = await pool.query("SELECT * FROM materias ORDER BY nombre");
  res.json(r.rows);
});

router.post("/materias", onlyAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: "Nombre requerido" });
  try {
    const r = await pool.query("INSERT INTO materias (nombre) VALUES ($1) RETURNING *", [nombre.trim()]);
    res.json(r.rows[0]);
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "Materia ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.delete("/materias/:id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM materias WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── MODO SIMPLIFICADO ─────────────────────────────────────────────────
// El sistema tiene DOS niveles para el modo simplificado:
//
//   1. Por MATERIA  (esta función): afecta a TODOS los profes que dan la
//      materia, en CUALQUIER período. Útil para materias como Ética y
//      Valores que siempre se llevan así.
//
//   2. Por ASIGNACIÓN (router de asignaciones): solo ese profe, esa sección,
//      ESE período. Útil para casos puntuales — por ejemplo el rescate de
//      notas del I Período cuando el sistema se implementó tarde.
//
// El sistema considera que una asignación está en modo simplificado si
// CUALQUIERA de los dos está marcado.
router.put("/materias/:id/simplificado", onlyAdmin, async (req, res) => {
  const { activo } = req.body;
  await pool.query("UPDATE materias SET modo_simplificado=$1 WHERE id=$2", [!!activo, req.params.id]);
  res.json({ ok: true, modo_simplificado: !!activo });
});

router.put("/asignaciones/:id/simplificado", onlyAdmin, async (req, res) => {
  // Body acepta:
  //   - activo (bool) — encender/apagar el flag general de la asignación
  //   - periodos (array de strings) — qué periodos quedan simplificados.
  //     Si activo=true pero periodos viene vacío, asumimos el periodo actual
  //     (compat hacia atrás con UI vieja que solo manda activo).
  const { activo, periodos } = req.body;
  const periodosFinal = Array.isArray(periodos) ? periodos.filter(Boolean) : null;

  // Si manda activo=false sin lista, vaciamos los periodos y apagamos el flag.
  // Si manda lista vacía explícitamente, también apagamos.
  let activoFinal = !!activo;
  let lista = periodosFinal || [];
  if (activoFinal && lista.length === 0) {
    // Activo sin periodos → no hace nada útil. Apagamos.
    activoFinal = false;
  }
  if (!activoFinal) lista = [];

  await pool.query(
    "UPDATE asignaciones SET modo_simplificado=$1, simplificado_periodos=$2 WHERE id=$3",
    [activoFinal, lista, req.params.id]
  );
  res.json({ ok: true, modo_simplificado: activoFinal, simplificado_periodos: lista });
});

// ── SECCIONES ─────────────────────────────────────────────────
router.get("/secciones", async (req, res) => {
  const r = await pool.query(`
    SELECT s.*,
      u.nombre AS guia_nombre, u.primer_apellido AS guia_ap1, u.segundo_apellido AS guia_ap2, u.id AS guia_id, u.cedula AS guia_cedula,
      o.id AS orient_id, o.nombre AS orient_nombre, o.primer_apellido AS orient_ap1, o.segundo_apellido AS orient_ap2, o.cedula AS orient_cedula
    FROM secciones s
    LEFT JOIN seccion_guia sg ON sg.seccion_id=s.id
    LEFT JOIN usuarios u ON u.id=sg.profesor_id
    LEFT JOIN (SELECT so.seccion_id, so.orientador_id FROM seccion_orientador so) so2 ON so2.seccion_id=s.id
    LEFT JOIN usuarios o ON o.id=so2.orientador_id
    ORDER BY s.nivel, s.nombre
  `);
  res.json(r.rows);
});

router.put("/secciones/:id/guia", onlyAdmin, async (req, res) => {
  const { profesor_id } = req.body;
  if (!profesor_id) return res.json({ ok: true });
  // Validar que no sea también orientador
  const esOrient = await pool.query("SELECT 1 FROM seccion_orientador WHERE orientador_id=$1 LIMIT 1", [profesor_id]);
  if (esOrient.rows.length > 0)
    return res.status(400).json({ error: "Este profesor ya está asignado como Orientador. Un profesor solo puede tener una función extra (guía O orientador, no ambas)." });
  await pool.query(`
    INSERT INTO seccion_guia (seccion_id,profesor_id) VALUES ($1,$2)
    ON CONFLICT (seccion_id) DO UPDATE SET profesor_id=$2
  `, [req.params.id, profesor_id]);
  res.json({ ok: true });
});

router.post("/secciones/:id/orientador", onlyAdmin, async (req, res) => {
  const { orientador_id } = req.body;
  if (!orientador_id) return res.json({ ok: true });
  // Validar que no sea también guía
  const esGuia = await pool.query("SELECT 1 FROM seccion_guia WHERE profesor_id=$1 LIMIT 1", [orientador_id]);
  if (esGuia.rows.length > 0)
    return res.status(400).json({ error: "Este profesor ya está asignado como Profesor Guía. Un profesor solo puede tener una función extra (guía O orientador, no ambas)." });
  await pool.query("DELETE FROM seccion_orientador WHERE seccion_id=$1", [req.params.id]);
  await pool.query("INSERT INTO seccion_orientador (seccion_id, orientador_id) VALUES ($1,$2)", [req.params.id, orientador_id]);
  res.json({ ok: true });
});

router.delete("/secciones/:seccion_id/orientador/:orientador_id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM seccion_orientador WHERE seccion_id=$1 AND orientador_id=$2", [req.params.seccion_id, req.params.orientador_id]);
  res.json({ ok: true });
});

// ── ASIGNACIONES ──────────────────────────────────────────────
// Por defecto muestra solo las del período actual; con ?todas=1 devuelve historial completo.
function periodoActualAdmin() {
  const hoy = new Date();
  return (hoy < new Date('2026-07-04T00:00:00')) ? 'I Período' : 'II Período';
}

router.get("/asignaciones", onlyAdmin, async (req, res) => {
  const todas = req.query.todas === '1';
  const periodo = periodoActualAdmin();
  // a.* ya trae a.modo_simplificado. También exponemos el de la materia
  // para que el frontend muestre "(toda la materia simplificada)" cuando
  // aplique y deshabilite el toggle individual.
  const sql = `
    SELECT a.*, COALESCE(a.periodo,'I Período') AS periodo,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.rol AS prof_rol,
      s.nombre AS seccion_nombre, m.nombre AS materia_nombre,
      COALESCE(m.modo_simplificado, false) AS materia_modo_simplificado
    FROM asignaciones a
    JOIN usuarios u ON u.id=a.profesor_id
    JOIN secciones s ON s.id=a.seccion_id
    JOIN materias m ON m.id=a.materia_id
    ${todas ? '' : "WHERE COALESCE(a.periodo,'I Período')=$1"}
    ORDER BY u.primer_apellido, s.nombre, m.nombre
  `;
  const r = await pool.query(sql, todas ? [] : [periodo]);
  res.json(r.rows);
});

router.post("/asignaciones", onlyAdmin, async (req, res) => {
  const { profesor_id, seccion_id, materia_id, lecciones_semana, subgrupo, periodo } = req.body;
  if (!profesor_id||!seccion_id||!materia_id) return res.status(400).json({ error: "Datos incompletos" });
  try {
    const r = await pool.query(`INSERT INTO asignaciones (profesor_id,seccion_id,materia_id,lecciones_semana,subgrupo,periodo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [profesor_id,seccion_id,materia_id,lecciones_semana||4,subgrupo||null,periodo||periodoActualAdmin()]);
    res.json({ ok:true, id:r.rows[0].id });
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "Asignación ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.delete("/asignaciones/:id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM asignaciones WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

router.put("/asignaciones/:id", onlyAdmin, async (req, res) => {
  const { profesor_id, seccion_id, materia_id, lecciones_semana, subgrupo } = req.body;
  if(!profesor_id || !seccion_id || !materia_id)
    return res.status(400).json({ error: "Faltan campos requeridos." });
  // Nota: NO se permite cambiar 'periodo' desde el editor manual (eso solo lo hace el módulo de intercambio)
  const r = await pool.query(
    `UPDATE asignaciones SET profesor_id=$1, seccion_id=$2, materia_id=$3,
     lecciones_semana=$4, subgrupo=$5 WHERE id=$6 RETURNING id`,
    [profesor_id, seccion_id, materia_id, lecciones_semana || 4, subgrupo || null, req.params.id]
  );
  if(!r.rows.length) return res.status(404).json({ error: "Asignación no encontrada." });
  res.json({ ok: true });
});

router.get("/profesores", async (req, res) => {
  const r = await pool.query(`SELECT id,cedula,nombre,primer_apellido,segundo_apellido,rol FROM usuarios WHERE rol IN ('profesor','profesor_guia','orientador') AND activo=true ORDER BY primer_apellido,nombre`);
  res.json(r.rows);
});

// ── DIAGNÓSTICO DE ESPACIO: cuánto ocupan las fotos en PostgreSQL ──────
// Solo admin. Reporta cuántos estudiantes tienen foto, el peso total,
// y cuántas son "grandes" (>200 KB en base64) — candidatas a re-compresión.
router.get("/diagnostico/fotos", onlyAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE foto_url IS NOT NULL AND foto_url <> '') AS total_con_foto,
        COUNT(*) AS total_estudiantes,
        COALESCE(SUM(LENGTH(foto_url)) FILTER (WHERE foto_url IS NOT NULL), 0) AS bytes_totales,
        COUNT(*) FILTER (WHERE LENGTH(foto_url) > 200000) AS grandes_a_recomprimir,
        COALESCE(SUM(LENGTH(foto_url)) FILTER (WHERE LENGTH(foto_url) > 200000), 0) AS bytes_grandes,
        COALESCE(AVG(LENGTH(foto_url)) FILTER (WHERE foto_url IS NOT NULL AND foto_url <> ''), 0)::bigint AS promedio_bytes,
        COALESCE(MAX(LENGTH(foto_url)), 0) AS max_bytes
      FROM estudiantes
    `);
    const row = r.rows[0];
    let bd_total_bytes = null;
    try {
      const sz = await pool.query("SELECT pg_database_size(current_database()) AS s");
      bd_total_bytes = sz.rows[0].s;
    } catch {}

    // Estado del proceso de re-compresión
    let estadoRec = null;
    try {
      const f = await pool.query("SELECT valor FROM sistema_flags WHERE codigo='RECOMPRIMIR_FOTOS_DONE'");
      if (f.rows.length) estadoRec = f.rows[0].valor;
    } catch {}

    res.json({
      total_estudiantes:        Number(row.total_estudiantes),
      total_con_foto:           Number(row.total_con_foto),
      bytes_totales:            Number(row.bytes_totales),
      mb_totales:               (Number(row.bytes_totales) / 1024 / 1024).toFixed(2),
      grandes_a_recomprimir:    Number(row.grandes_a_recomprimir),
      bytes_grandes:            Number(row.bytes_grandes),
      mb_grandes:               (Number(row.bytes_grandes) / 1024 / 1024).toFixed(2),
      promedio_kb:              (Number(row.promedio_bytes) / 1024).toFixed(1),
      max_kb:                   (Number(row.max_bytes) / 1024).toFixed(1),
      bd_total_mb:              bd_total_bytes ? (Number(bd_total_bytes) / 1024 / 1024).toFixed(2) : null,
      recompresion_estado:      estadoRec,
    });
  } catch (e) {
    console.error("diagnostico/fotos:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── BORRAR TODAS LAS FOTOS ─────────────────────────────────────────────
// Solo admin. Pone foto_url=NULL en todos los estudiantes (activos o no).
// Devuelve cuántas fotos había antes para mostrar al usuario.
// NO se hace respaldo: la idea es liberar espacio de la BD.
router.post("/borrar-fotos", onlyAdmin, async (req, res) => {
  try {
    // Conteo y peso antes
    const antes = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE foto_url IS NOT NULL AND foto_url <> '') AS cantidad,
             COALESCE(SUM(LENGTH(foto_url)) FILTER (WHERE foto_url IS NOT NULL), 0) AS bytes
      FROM estudiantes
    `);
    const cantidad = Number(antes.rows[0].cantidad);
    const bytes = Number(antes.rows[0].bytes);

    if (cantidad === 0) {
      return res.json({ ok: true, cantidad: 0, mb_liberados: "0.00", mensaje: "No había fotos para borrar." });
    }

    // Borrar
    await pool.query("UPDATE estudiantes SET foto_url=NULL WHERE foto_url IS NOT NULL");

    // VACUUM para liberar realmente el espacio físico en disco.
    // No se puede correr dentro de una transacción, lo hacemos suelto.
    try {
      await pool.query("VACUUM estudiantes");
    } catch (e) {
      // Si VACUUM falla (permisos), no es crítico — el espacio se libera con el tiempo.
      console.warn("VACUUM estudiantes:", e.message);
    }

    const u = req.session.usuario;
    console.log(`[FOTOS] Admin ${u.id} (${u.cedula}) borró ${cantidad} fotos (${(bytes/1024/1024).toFixed(2)} MB)`);

    res.json({
      ok: true,
      cantidad,
      mb_liberados: (bytes / 1024 / 1024).toFixed(2)
    });
  } catch (e) {
    console.error("borrar-fotos:", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

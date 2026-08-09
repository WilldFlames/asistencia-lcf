// ════════════════════════════════════════════════════════════════════
//  PROTOCOLOS DE ATENCIÓN — 9 Pautas con 12 formularios oficiales MEP
// ════════════════════════════════════════════════════════════════════
const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { asignarConsecutivoInterno } = require("./consecutivos");

// Mapeo oficial de cada pauta a los formularios que incluye, EN ORDEN.
const PAUTAS = {
  1: { nombre: "Violencia física y psicológica entre personas estudiantes",
       formularios: ["F1","F5","F6","F7","F10","F11","F12"] },
  2: { nombre: "Violencia sexual entre personas estudiantes",
       formularios: ["F1","F5","F6","F7","F10","F12"] },
  3: { nombre: "Bullying (acoso escolar)",
       formularios: ["F1","F6","F7","F10","F11","F12"] },
  4: { nombre: "Violencia ejercida por una persona funcionaria contra una persona estudiante",
       formularios: ["F1","F5","F7","F8","F11","F12"] },
  5: { nombre: "Violencia ejercida por una tercera persona contra una persona estudiante",
       formularios: ["F1","F5","F7","F8","F12"] },
  6: { nombre: "Riesgo de autolesión y comportamiento suicida",
       formularios: ["F2","F7","F9","F10","F11","F12"] },
  7: { nombre: "Hallazgo, tenencia, consumo y tráfico de drogas y sustancias psicoactivas",
       formularios: ["F2","F4","F5","F7","F8","F10","F11","F12"] },
  8: { nombre: "Hallazgo, tenencia y uso de armas por personas estudiantes",
       formularios: ["F2","F3","F4","F7","F8","F11","F12"] },
  9: { nombre: "Embarazo, postparto y lactancia en estudiantes",
       formularios: ["F2","F5","F7","F11","F12"] },
};

function puedeAccederProtocolo(u, p) {
  if (["admin","auxiliar","administrativo","secretaria"].includes(u.rol)) return true;
  if (p.iniciado_por === u.id) return true;
  if (p.orientador_id === u.id) return true;
  return false;
}
function puedeEditar(u, p) {
  if (["admin","auxiliar","administrativo"].includes(u.rol)) return true;
  return p.iniciado_por === u.id;
}

// Helper: crear notificación interna (la campanita).
// Falla silenciosa: si la tabla no existe o el usuario es null, no rompe.
async function notificar(usuarioId, tipo, mensaje) {
  if (!usuarioId) return;
  try {
    await pool.query(
      "INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1,$2,$3)",
      [usuarioId, tipo, mensaje]
    );
  } catch (e) {
    console.error("Notif Protocolo:", e.message);
  }
}

// ── CATÁLOGO de pautas ─────────────────────────────────────────────────
router.get("/catalogo/pautas", requireAuth, (req, res) => {
  res.json(PAUTAS);
});

// ── CONFIG del centro ──────────────────────────────────────────────────
router.get("/config-centro", requireAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM config_centro ORDER BY id LIMIT 1");
    res.json(r.rows[0] || {});
  } catch (e) {
    if (e.code === '42P01') return res.json({});
    res.status(500).json({ error: e.message });
  }
});
router.put("/config-centro", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if (!["admin","auxiliar","administrativo"].includes(u.rol)) {
    return res.status(403).json({ error: "Sin permisos para editar la configuración del centro." });
  }
  const { nombre_centro, codigo_presupuestario, circuito_escolar, dre, telefono, correo, direccion, director_nombre, director_cedula } = req.body;
  const existe = await pool.query("SELECT id FROM config_centro ORDER BY id LIMIT 1");
  if (!existe.rows.length) {
    await pool.query(`INSERT INTO config_centro (nombre_centro, codigo_presupuestario, circuito_escolar, dre, telefono, correo, direccion, director_nombre, director_cedula, updated_by)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [nombre_centro||null, codigo_presupuestario||null, circuito_escolar||null, dre||null, telefono||null, correo||null, direccion||null, director_nombre||null, director_cedula||null, u.id]);
  } else {
    await pool.query(`UPDATE config_centro SET nombre_centro=$1, codigo_presupuestario=$2, circuito_escolar=$3, dre=$4, telefono=$5, correo=$6, direccion=$7, director_nombre=$8, director_cedula=$9, updated_at=NOW(), updated_by=$10 WHERE id=$11`,
      [nombre_centro||null, codigo_presupuestario||null, circuito_escolar||null, dre||null, telefono||null, correo||null, direccion||null, director_nombre||null, director_cedula||null, u.id, existe.rows[0].id]);
  }
  res.json({ ok: true });
});

// ── PENDIENTES como orientador (DEBE ir ANTES de /:id) ─────────────────
router.get("/pendientes/orientador", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  try {
    const r = await pool.query(`
      SELECT p.id, p.numero, p.anio, p.pauta, p.created_at,
             ini.primer_apellido AS ini_ap1, ini.segundo_apellido AS ini_ap2, ini.nombre AS ini_nombre
      FROM protocolos p
      LEFT JOIN usuarios ini ON ini.id = p.iniciado_por
      WHERE p.orientador_id = $1 AND p.estado = 'activo'
      ORDER BY p.updated_at DESC
    `, [u.id]);
    res.json(r.rows.map(x => ({ ...x, pauta_nombre: PAUTAS[x.pauta]?.nombre })));
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── LISTAR protocolos ──────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const u = req.session.usuario;
    const { estado } = req.query;
    const where = [];
    const params = [];
    if (estado && estado !== 'todos') {
      params.push(estado);
      where.push(`p.estado = $${params.length}`);
    }
    const esStaff = ["admin","auxiliar","administrativo","secretaria"].includes(u.rol);
    if (!esStaff) {
      params.push(u.id);
      const iU = params.length;
      where.push(`(p.iniciado_por = $${iU} OR p.orientador_id = $${iU})`);
    }
    const sql = `
      SELECT p.id, p.numero, p.anio, p.pauta, p.estado, p.created_at, p.updated_at,
             p.iniciado_por,
             ini.primer_apellido AS ini_ap1, ini.segundo_apellido AS ini_ap2, ini.nombre AS ini_nombre,
             ori.primer_apellido AS ori_ap1, ori.segundo_apellido AS ori_ap2, ori.nombre AS ori_nombre,
             (SELECT COUNT(*) FROM protocolo_formularios pf WHERE pf.protocolo_id=p.id AND pf.estado='completado')::int AS f_completados,
             (SELECT COUNT(*) FROM protocolo_formularios pf WHERE pf.protocolo_id=p.id AND pf.estado='no_aplica')::int AS f_no_aplica,
             (SELECT COUNT(*) FROM protocolo_formularios pf WHERE pf.protocolo_id=p.id)::int AS f_total,
             (SELECT string_agg(
                COALESCE(NULLIF(pp.nombre_completo,''),
                         CONCAT_WS(' ', e.nombre, e.primer_apellido, e.segundo_apellido)),
                ' / ')
              FROM protocolo_personas pp LEFT JOIN estudiantes e ON e.id = pp.estudiante_id
              WHERE pp.protocolo_id = p.id AND pp.rol = 'afectado'
             ) AS afectados_txt
      FROM protocolos p
      LEFT JOIN usuarios ini ON ini.id = p.iniciado_por
      LEFT JOIN usuarios ori ON ori.id = p.orientador_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.updated_at DESC, p.id DESC
    `;
    const r = await pool.query(sql, params);
    const rows = r.rows.map(x => ({ ...x, pauta_nombre: PAUTAS[x.pauta]?.nombre || `Pauta ${x.pauta}` }));
    res.json(rows);
  } catch (e) {
    console.error("GET protocolos:", e);
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── DETALLE ────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const u = req.session.usuario;
    const pR = await pool.query(`
      SELECT p.*,
             ini.primer_apellido AS ini_ap1, ini.segundo_apellido AS ini_ap2, ini.nombre AS ini_nombre, ini.cedula AS ini_cedula,
             ori.primer_apellido AS ori_ap1, ori.segundo_apellido AS ori_ap2, ori.nombre AS ori_nombre, ori.cedula AS ori_cedula
      FROM protocolos p
      LEFT JOIN usuarios ini ON ini.id = p.iniciado_por
      LEFT JOIN usuarios ori ON ori.id = p.orientador_id
      WHERE p.id = $1
    `, [req.params.id]);
    if (!pR.rows.length) return res.status(404).json({ error: "Protocolo no encontrado" });
    const p = pR.rows[0];
    if (!puedeAccederProtocolo(u, p)) return res.status(403).json({ error: "Sin permisos" });

    const fR = await pool.query(`
      SELECT pf.*, uc.primer_apellido AS comp_ap1, uc.segundo_apellido AS comp_ap2, uc.nombre AS comp_nombre
      FROM protocolo_formularios pf
      LEFT JOIN usuarios uc ON uc.id = pf.completado_por
      WHERE pf.protocolo_id = $1
      ORDER BY pf.orden
    `, [req.params.id]);

    const persR = await pool.query(`
      SELECT pp.*,
             e.cedula AS est_cedula, e.nombre AS est_nombre, e.primer_apellido AS est_ap1, e.segundo_apellido AS est_ap2,
             e.fecha_nacimiento AS est_fnac,
             s.nombre AS est_seccion
      FROM protocolo_personas pp
      LEFT JOIN estudiantes e ON e.id = pp.estudiante_id
      LEFT JOIN secciones s ON s.id = e.seccion_id
      WHERE pp.protocolo_id = $1
      ORDER BY
        CASE pp.rol WHEN 'afectado' THEN 1 WHEN 'ofensor' THEN 2 WHEN 'observador' THEN 3 ELSE 4 END,
        pp.id
    `, [req.params.id]);

    // Autocompletar encargados de cada estudiante registrado
    for (const pers of persR.rows) {
      if (pers.estudiante_id) {
        try {
          const eR = await pool.query(`SELECT nombre_completo, cedula, telefono FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC NULLS LAST LIMIT 1`, [pers.estudiante_id]);
          if (eR.rows.length) {
            pers.enc_nombre = eR.rows[0].nombre_completo;
            pers.enc_cedula = eR.rows[0].cedula;
            pers.enc_telefono = eR.rows[0].telefono;
          }
        } catch {}
      }
    }

    res.json({
      protocolo: { ...p, pauta_nombre: PAUTAS[p.pauta]?.nombre },
      formularios: fR.rows,
      personas: persR.rows,
      pauta_def: PAUTAS[p.pauta],
      puede_editar: puedeEditar(u, p),
    });
  } catch (e) {
    console.error("GET /:id protocolos:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── INICIAR ────────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { pauta, personas, orientador_id } = req.body;
  if (!pauta || !PAUTAS[pauta]) return res.status(400).json({ error: "Pauta inválida" });
  if (!Array.isArray(personas) || !personas.length) {
    return res.status(400).json({ error: "Indicá al menos una persona involucrada." });
  }
  if (!personas.some(p => p.rol === 'afectado')) {
    return res.status(400).json({ error: "Debe haber al menos una persona en rol 'afectado'." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cons = await asignarConsecutivoInterno("protocolo", u.id, { estudiante_id: null, descripcion: PAUTAS[pauta].nombre });
    if (!cons) throw new Error("No se pudo asignar consecutivo de protocolo (revisar capacidad).");

    // Autoasignar orientador desde la sección del afectado (si es interno).
    // Si la persona afectada es interna (tiene estudiante_id), buscamos al
    // orientador asignado a su sección. Si es externa o no tiene orientador
    // asignado, queda en NULL — el admin puede asignarlo manualmente después.
    let orientadorFinal = null;
    const afectado = personas.find(p => p.rol === 'afectado');
    if (afectado && afectado.estudiante_id) {
      const ori = await client.query(`
        SELECT so.orientador_id
        FROM estudiantes e
        JOIN seccion_orientador so ON so.seccion_id = e.seccion_id
        WHERE e.id = $1 AND so.orientador_id IS NOT NULL
        LIMIT 1
      `, [afectado.estudiante_id]);
      if (ori.rows.length) orientadorFinal = ori.rows[0].orientador_id;
    }

    const anio = new Date().getFullYear();
    const pR = await client.query(`
      INSERT INTO protocolos (consecutivo_id, numero, anio, pauta, iniciado_por, orientador_id)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [cons.id, cons.numero, anio, pauta, u.id, orientadorFinal]);
    const proto = pR.rows[0];

    const formularios = PAUTAS[pauta].formularios;
    for (let i = 0; i < formularios.length; i++) {
      await client.query(`
        INSERT INTO protocolo_formularios (protocolo_id, tipo, orden, estado)
        VALUES ($1, $2, $3, 'pendiente')
      `, [proto.id, formularios[i], i + 1]);
    }

    for (const pers of personas) {
      await client.query(`
        INSERT INTO protocolo_personas (protocolo_id, estudiante_id, es_externo, es_mayor_edad, rol, nombre_completo, cedula, edad, seccion, fecha_nacimiento, telefono, correo, direccion, encargado_nombre, encargado_cedula, encargado_telef, notas)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `, [
        proto.id, pers.estudiante_id || null, !!pers.es_externo, !!pers.es_mayor_edad, pers.rol,
        pers.nombre_completo || null, pers.cedula || null, pers.edad || null, pers.seccion || null,
        pers.fecha_nacimiento || null, pers.telefono || null, pers.correo || null, pers.direccion || null,
        pers.encargado_nombre || null, pers.encargado_cedula || null, pers.encargado_telef || null, pers.notas || null,
      ]);
    }

    await client.query("COMMIT");

    // Notificar al orientador (si fue autoasignado y no es el mismo iniciador)
    if (orientadorFinal && orientadorFinal !== u.id) {
      await notificar(orientadorFinal, "protocolo",
        `🛡️ Se inició un protocolo (N°${String(proto.numero).padStart(3,'0')}-${proto.anio}) — ${PAUTAS[pauta].nombre} — en una sección que orientás. Vas a poder revisarlo cuando se completen los formularios.`);
    }

    res.json({ ok: true, id: proto.id, numero: proto.numero, anio: proto.anio, orientador_asignado: orientadorFinal });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST protocolos:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GUARDAR formulario ─────────────────────────────────────────────────
router.post("/:id/formularios/:formId", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { contenido, marcar_completado, marcar_no_aplica, marcar_pendiente } = req.body;

  const pR = await pool.query("SELECT * FROM protocolos WHERE id=$1", [req.params.id]);
  if (!pR.rows.length) return res.status(404).json({ error: "Protocolo no encontrado" });
  const p = pR.rows[0];
  if (!puedeEditar(u, p)) return res.status(403).json({ error: "Sin permisos para editar" });
  if (p.estado !== 'activo') return res.status(400).json({ error: "El protocolo está cerrado." });

  const fR = await pool.query("SELECT * FROM protocolo_formularios WHERE id=$1 AND protocolo_id=$2", [req.params.formId, req.params.id]);
  if (!fR.rows.length) return res.status(404).json({ error: "Formulario no encontrado" });

  let nuevoEstado = fR.rows[0].estado;
  let completadoPor = fR.rows[0].completado_por;
  let completadoEn = fR.rows[0].completado_en;

  if (marcar_no_aplica) {
    nuevoEstado = 'no_aplica';
    completadoPor = u.id;
    completadoEn = new Date();
  } else if (marcar_completado) {
    nuevoEstado = 'completado';
    completadoPor = u.id;
    completadoEn = new Date();
  } else if (marcar_pendiente) {
    nuevoEstado = 'pendiente';
    completadoPor = null;
    completadoEn = null;
  }

  await pool.query(`
    UPDATE protocolo_formularios
    SET contenido = $1, estado = $2, completado_por = $3, completado_en = $4, updated_at = NOW()
    WHERE id = $5
  `, [contenido || {}, nuevoEstado, completadoPor, completadoEn, req.params.formId]);

  await pool.query("UPDATE protocolos SET updated_at = NOW() WHERE id = $1", [req.params.id]);

  // Notificar al orientador cuando se completa (no cuando se marca N/A o pendiente)
  if (marcar_completado && p.orientador_id && p.orientador_id !== u.id) {
    const tipoForm = fR.rows[0].tipo;
    await notificar(p.orientador_id, "protocolo",
      `🛡️ Se completó el formulario ${tipoForm} del protocolo N°${String(p.numero).padStart(3,'0')}-${p.anio}. Podés revisarlo.`);
  }

  res.json({ ok: true, estado: nuevoEstado });
});

// ── AGREGAR persona ────────────────────────────────────────────────────
router.post("/:id/personas", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const pR = await pool.query("SELECT * FROM protocolos WHERE id=$1", [req.params.id]);
  if (!pR.rows.length) return res.status(404).json({ error: "Protocolo no encontrado" });
  if (!puedeEditar(u, pR.rows[0])) return res.status(403).json({ error: "Sin permisos" });

  const pers = req.body;
  if (!pers.rol) return res.status(400).json({ error: "Falta el rol" });

  await pool.query(`
    INSERT INTO protocolo_personas (protocolo_id, estudiante_id, es_externo, es_mayor_edad, rol, nombre_completo, cedula, edad, seccion, fecha_nacimiento, telefono, correo, direccion, encargado_nombre, encargado_cedula, encargado_telef, notas)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  `, [
    req.params.id, pers.estudiante_id || null, !!pers.es_externo, !!pers.es_mayor_edad, pers.rol,
    pers.nombre_completo || null, pers.cedula || null, pers.edad || null, pers.seccion || null,
    pers.fecha_nacimiento || null, pers.telefono || null, pers.correo || null, pers.direccion || null,
    pers.encargado_nombre || null, pers.encargado_cedula || null, pers.encargado_telef || null, pers.notas || null,
  ]);
  res.json({ ok: true });
});

router.delete("/:id/personas/:persId", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const pR = await pool.query("SELECT * FROM protocolos WHERE id=$1", [req.params.id]);
  if (!pR.rows.length) return res.status(404).json({ error: "Protocolo no encontrado" });
  if (!puedeEditar(u, pR.rows[0])) return res.status(403).json({ error: "Sin permisos" });
  await pool.query("DELETE FROM protocolo_personas WHERE id=$1 AND protocolo_id=$2", [req.params.persId, req.params.id]);
  res.json({ ok: true });
});

// ── CERRAR ─────────────────────────────────────────────────────────────
router.post("/:id/cerrar", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const pR = await pool.query("SELECT * FROM protocolos WHERE id=$1", [req.params.id]);
  if (!pR.rows.length) return res.status(404).json({ error: "Protocolo no encontrado" });
  const p = pR.rows[0];
  if (!puedeEditar(u, p)) return res.status(403).json({ error: "Sin permisos" });
  await pool.query("UPDATE protocolos SET estado='cerrado', fecha_cierre=NOW(), updated_at=NOW() WHERE id=$1", [req.params.id]);

  // Notificar a iniciador y orientador (los que no son el usuario actual)
  const nroTxt = `N°${String(p.numero).padStart(3,'0')}-${p.anio}`;
  if (p.iniciado_por && p.iniciado_por !== u.id) {
    await notificar(p.iniciado_por, "protocolo",
      `🛡️ El protocolo ${nroTxt} fue cerrado.`);
  }
  if (p.orientador_id && p.orientador_id !== u.id && p.orientador_id !== p.iniciado_por) {
    await notificar(p.orientador_id, "protocolo",
      `🛡️ El protocolo ${nroTxt} fue cerrado.`);
  }

  res.json({ ok: true });
});

router.post("/:id/reabrir", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if (!["admin","auxiliar","administrativo"].includes(u.rol)) {
    return res.status(403).json({ error: "Solo administración puede reabrir" });
  }
  await pool.query("UPDATE protocolos SET estado='activo', fecha_cierre=NULL, updated_at=NOW() WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── ELIMINAR un protocolo completo (solo admin/administrativo) ────────
// Borra el protocolo, sus formularios y personas. Libera el consecutivo.
// IRREVERSIBLE — pensada para limpiar registros de prueba.
router.delete("/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  if (!["admin","administrativo"].includes(u.rol)) {
    return res.status(403).json({ error: "Solo administración puede eliminar protocolos." });
  }
  const pR = await pool.query("SELECT id, consecutivo_id, numero, anio FROM protocolos WHERE id=$1", [req.params.id]);
  if (!pR.rows.length) return res.status(404).json({ error: "Protocolo no encontrado" });
  const p = pR.rows[0];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM protocolo_personas WHERE protocolo_id=$1", [p.id]);
    await client.query("DELETE FROM protocolo_formularios WHERE protocolo_id=$1", [p.id]);
    await client.query("DELETE FROM protocolos WHERE id=$1", [p.id]);
    if (p.consecutivo_id) {
      await client.query("DELETE FROM consecutivos WHERE id=$1", [p.consecutivo_id]);
    }
    await client.query("COMMIT");
    res.json({ ok: true, consecutivo_liberado: p.numero, anio: p.anio });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("DELETE protocolo:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;

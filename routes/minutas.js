// ════════════════════════════════════════════════════════════════════════
//  MINUTAS — Hoja para Minutas del Liceo de Calle Fallas
// ════════════════════════════════════════════════════════════════════════
// Registro de reuniones internas (consejo de profesores, comités, equipos
// de orientación, etc). Cualquier persona del personal puede crear una
// minuta. El consecutivo MIN-NNN-AAAA usa el mismo sistema central.
//
// Endpoints:
//   GET    /                       Lista (filtra por estado / año / mías)
//   GET    /:id                    Detalle con asistentes
//   POST   /                       Crear minuta (asigna consecutivo)
//   PUT    /:id                    Editar cabecera
//   POST   /:id/asistentes         Agregar asistente
//   DELETE /:id/asistentes/:aid    Quitar asistente
//   POST   /:id/finalizar          Cerrar minuta (estado='finalizada')
//   POST   /:id/reabrir            Reabrir minuta (admin/administrativo)
//   DELETE /:id                    Eliminar (libera consecutivo)

const express = require("express");
const router = express.Router();
const pool = require("../db").pool;
const { asignarConsecutivoInterno } = require("./consecutivos");

// Helpers de sesión y roles (replicados del patrón de otros módulos)
function requireAuth(req, res, next){
  if (!req.session.usuario) return res.status(401).json({ error:"No autorizado" });
  next();
}
function esStaff(rol){ return ["admin","administrativo"].includes(rol); }

// ───────────────────────────────────────────────────────────────────────
//  GET /  — lista de minutas
// ───────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────
//  Reglas de privacidad de minutas:
//  - Cada minuta la ven SOLO el usuario que la inició (iniciada_por) y los
//    usuarios marcados como PRESENTES (minuta_asistentes.tipo='presente'
//    con usuario_id conocido).
//  - Cualquier otro rol NO puede verla, ni siquiera admin, para proteger
//    información delicada (Junta, Personal, casos de conducta, etc.).
// ───────────────────────────────────────────────────────────────────────
function filtroVisibilidadSQL(paramIndexStart){
  // Devuelve la condición SQL y el índice del parámetro donde se coloca u.id
  const idx = paramIndexStart;
  return `(m.iniciada_por = $${idx} OR EXISTS (
    SELECT 1 FROM minuta_asistentes ma
    WHERE ma.minuta_id = m.id AND ma.tipo = 'presente' AND ma.usuario_id = $${idx}
  ))`;
}

router.get("/", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const { estado, anio, mias } = req.query;
  const where = []; const params = [];
  if (estado) { params.push(estado); where.push(`m.estado = $${params.length}`); }
  if (anio)   { params.push(parseInt(anio)); where.push(`m.anio = $${params.length}`); }
  if (mias === '1') {
    params.push(u.id);
    where.push(`m.iniciada_por = $${params.length}`);
  }
  // Filtro de privacidad: solo iniciador + presentes
  params.push(u.id);
  where.push(filtroVisibilidadSQL(params.length));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  try {
    const r = await pool.query(`
      SELECT m.*,
        u.primer_apellido AS ini_ap1, u.segundo_apellido AS ini_ap2,
        u.nombre AS ini_nombre, u.rol AS ini_rol,
        (SELECT COUNT(*) FROM minuta_asistentes ma WHERE ma.minuta_id = m.id AND ma.tipo='presente') AS presentes,
        (SELECT COUNT(*) FROM minuta_asistentes ma WHERE ma.minuta_id = m.id AND ma.tipo='ausente') AS ausentes
      FROM minutas m
      LEFT JOIN usuarios u ON u.id = m.iniciada_por
      ${w}
      ORDER BY m.anio DESC, m.numero DESC
    `, params);
    res.json(r.rows);
  } catch (e) {
    console.error("GET /minutas:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
//  GET /:id  — detalle con asistentes
// ───────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────
//  Helper: verificar que el usuario tiene acceso a la minuta
//  (es el iniciador o es un presente). Devuelve true/false.
// ───────────────────────────────────────────────────────────────────────
async function puedeVerMinuta(minutaId, usuarioId){
  const r = await pool.query(`
    SELECT 1 FROM minutas m
    WHERE m.id = $1 AND (
      m.iniciada_por = $2 OR EXISTS (
        SELECT 1 FROM minuta_asistentes ma
        WHERE ma.minuta_id = m.id AND ma.tipo='presente' AND ma.usuario_id = $2
      )
    )
    LIMIT 1
  `, [minutaId, usuarioId]);
  return r.rows.length > 0;
}

router.get("/:id", requireAuth, async (req, res) => {
  try {
    // Verificar acceso antes de devolver la data
    const puede = await puedeVerMinuta(req.params.id, req.session.usuario.id);
    if(!puede) return res.status(403).json({ error: "No tenés acceso a esta minuta. Solo el iniciador y las personas marcadas como presentes pueden verla." });
    const mR = await pool.query(`
      SELECT m.*,
        u.primer_apellido AS ini_ap1, u.segundo_apellido AS ini_ap2,
        u.nombre AS ini_nombre, u.cedula AS ini_cedula, u.rol AS ini_rol
      FROM minutas m
      LEFT JOIN usuarios u ON u.id = m.iniciada_por
      WHERE m.id = $1
    `, [req.params.id]);
    if (!mR.rows.length) return res.status(404).json({ error:"Minuta no encontrada" });
    const aR = await pool.query(`
      SELECT ma.*,
        u.primer_apellido AS u_ap1, u.segundo_apellido AS u_ap2, u.nombre AS u_nombre, u.cedula AS u_cedula
      FROM minuta_asistentes ma
      LEFT JOIN usuarios u ON u.id = ma.usuario_id
      WHERE ma.minuta_id = $1
      ORDER BY ma.tipo, ma.orden, ma.id
    `, [req.params.id]);
    res.json({ minuta: mR.rows[0], asistentes: aR.rows });
  } catch (e) {
    console.error("GET /minutas/:id:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
//  POST /  — crear minuta (cualquier usuario autenticado)
// ───────────────────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  const {
    tipo_reunion, plataforma, dependencia, lugar, fecha_reunion,
    hora_inicio, hora_fin, tema, elaborada_por
  } = req.body;

  const tipo = (tipo_reunion === 'virtual') ? 'virtual' : 'presencial';
  const anio = new Date().getFullYear();

  // Asignar consecutivo tipo 'minuta'
  let consec;
  try {
    consec = await asignarConsecutivoInterno("minuta", u.id, {
      motivo_proceso: tema || 'Minuta de reunión',
    });
  } catch (e) {
    return res.status(400).json({ error: "No se pudo asignar consecutivo: " + e.message });
  }

  try {
    const r = await pool.query(`
      INSERT INTO minutas
        (consecutivo_id, numero, anio, iniciada_por,
         tipo_reunion, plataforma, dependencia, lugar, fecha_reunion,
         hora_inicio, hora_fin, tema, elaborada_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id, numero, anio
    `, [
      consec.id, consec.numero, anio, u.id,
      tipo, plataforma || '', dependencia || 'Liceo de Calle Fallas',
      lugar || '', fecha_reunion || null,
      hora_inicio || '', hora_fin || '', tema || '',
      elaborada_por || `${u.primer_apellido||''} ${u.segundo_apellido||''} ${u.nombre||''}`.replace(/\s+/g,' ').trim()
    ]);

    // Auto-agregar al creador como primer presente
    const nombreCreador = `${u.primer_apellido||''} ${u.segundo_apellido||''} ${u.nombre||''}`.replace(/\s+/g,' ').trim();
    const puestoCreador = u.rol || '';
    await pool.query(`
      INSERT INTO minuta_asistentes (minuta_id, usuario_id, nombre, puesto, tipo, orden)
      VALUES ($1, $2, $3, $4, 'presente', 1)
    `, [r.rows[0].id, u.id, nombreCreador, puestoCreador]);

    console.log(`[MINUTA] Creada N°${r.rows[0].numero}-${r.rows[0].anio} por usuario ${u.id} (${u.rol})`);
    res.json({ ok:true, id: r.rows[0].id, numero: r.rows[0].numero, anio: r.rows[0].anio });
  } catch (e) {
    console.error("POST /minutas:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
//  PUT /:id  — editar cabecera de minuta
// ───────────────────────────────────────────────────────────────────────
router.put("/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  try {
    const mR = await pool.query("SELECT iniciada_por, estado FROM minutas WHERE id=$1", [req.params.id]);
    if (!mR.rows.length) return res.status(404).json({ error:"Minuta no encontrada" });
    const m = mR.rows[0];
    // Solo el creador puede editar. Por privacidad, ni siquiera admin
    // puede tocar minutas ajenas — pueden contener información sensible.
    if (m.iniciada_por !== u.id) {
      return res.status(403).json({ error:"Solo la persona que inició la minuta puede editarla." });
    }
    if (m.estado === 'finalizada') {
      return res.status(403).json({ error:"La minuta está finalizada. Reabrila si necesitás editar." });
    }

    const {
      tipo_reunion, plataforma, dependencia, lugar, fecha_reunion,
      hora_inicio, hora_fin, tema, elaborada_por, temas_tratados, acuerdos
    } = req.body;

    await pool.query(`
      UPDATE minutas SET
        tipo_reunion = COALESCE($1, tipo_reunion),
        plataforma   = COALESCE($2, plataforma),
        dependencia  = COALESCE($3, dependencia),
        lugar        = COALESCE($4, lugar),
        fecha_reunion= COALESCE($5, fecha_reunion),
        hora_inicio  = COALESCE($6, hora_inicio),
        hora_fin     = COALESCE($7, hora_fin),
        tema         = COALESCE($8, tema),
        elaborada_por= COALESCE($9, elaborada_por),
        temas_tratados = COALESCE($10, temas_tratados),
        acuerdos     = COALESCE($11, acuerdos),
        updated_at   = NOW()
      WHERE id = $12
    `, [
      tipo_reunion || null, plataforma, dependencia, lugar, fecha_reunion || null,
      hora_inicio, hora_fin, tema, elaborada_por, temas_tratados, acuerdos,
      req.params.id
    ]);
    res.json({ ok:true });
  } catch (e) {
    console.error("PUT /minutas/:id:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
//  POST /:id/asistentes  — agregar asistente (presente o ausente)
// ───────────────────────────────────────────────────────────────────────
// Body: { usuario_id?, nombre, puesto, tipo: 'presente'|'ausente', justificacion? }
router.post("/:id/asistentes", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  let { usuario_id, nombre, puesto, tipo, justificacion } = req.body;
  if (!tipo || !['presente','ausente'].includes(tipo)) {
    return res.status(400).json({ error:"Tipo inválido (debe ser 'presente' o 'ausente')" });
  }
  try {
    const mR = await pool.query("SELECT estado, iniciada_por FROM minutas WHERE id=$1", [req.params.id]);
    if (!mR.rows.length) return res.status(404).json({ error:"Minuta no encontrada" });
    // Solo el creador puede modificar asistentes
    if (mR.rows[0].iniciada_por !== u.id) {
      return res.status(403).json({ error:"Solo la persona que inició la minuta puede modificar asistentes." });
    }
    if (mR.rows[0].estado === 'finalizada') {
      return res.status(403).json({ error:"Minuta finalizada. Reabrila si necesitás modificar asistentes." });
    }

    // Si es del sistema, traer nombre y puesto reales (snapshot)
    if (usuario_id) {
      const uR = await pool.query(
        "SELECT primer_apellido, segundo_apellido, nombre, rol FROM usuarios WHERE id=$1 AND activo=true",
        [usuario_id]
      );
      if (!uR.rows.length) return res.status(400).json({ error:"Usuario no encontrado o inactivo" });
      const ud = uR.rows[0];
      nombre = `${ud.primer_apellido||''} ${ud.segundo_apellido||''} ${ud.nombre||''}`.replace(/\s+/g,' ').trim();
      if (!puesto) puesto = ud.rol;
    } else {
      // Externo: requiere nombre
      if (!nombre || !nombre.trim()) return res.status(400).json({ error:"Falta el nombre" });
    }

    // Calcular orden
    const oR = await pool.query(
      "SELECT COALESCE(MAX(orden), 0) AS m FROM minuta_asistentes WHERE minuta_id=$1 AND tipo=$2",
      [req.params.id, tipo]
    );
    const orden = (oR.rows[0].m || 0) + 1;

    await pool.query(`
      INSERT INTO minuta_asistentes (minuta_id, usuario_id, nombre, puesto, tipo, justificacion, orden)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      req.params.id, usuario_id || null, nombre.trim(),
      (puesto||'').trim(), tipo,
      tipo === 'ausente' ? (justificacion || 'injustificado') : null,
      orden
    ]);
    res.json({ ok:true });
  } catch (e) {
    console.error("POST /minutas/:id/asistentes:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
//  DELETE /:id/asistentes/:aid  — quitar asistente
// ───────────────────────────────────────────────────────────────────────
router.delete("/:id/asistentes/:aid", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  try {
    const mR = await pool.query("SELECT estado, iniciada_por FROM minutas WHERE id=$1", [req.params.id]);
    if (!mR.rows.length) return res.status(404).json({ error:"Minuta no encontrada" });
    if (mR.rows[0].iniciada_por !== u.id) {
      return res.status(403).json({ error:"Solo la persona que inició la minuta puede quitar asistentes." });
    }
    if (mR.rows[0].estado === 'finalizada') {
      return res.status(403).json({ error:"Minuta finalizada. Reabrila si necesitás modificar asistentes." });
    }
    await pool.query("DELETE FROM minuta_asistentes WHERE id=$1 AND minuta_id=$2",
      [req.params.aid, req.params.id]);
    res.json({ ok:true });
  } catch (e) {
    console.error("DELETE /minutas/:id/asistentes/:aid:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
//  POST /:id/finalizar  — cerrar la minuta
// ───────────────────────────────────────────────────────────────────────
router.post("/:id/finalizar", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  try {
    const mR = await pool.query("SELECT iniciada_por, estado FROM minutas WHERE id=$1", [req.params.id]);
    if (!mR.rows.length) return res.status(404).json({ error:"Minuta no encontrada" });
    if (mR.rows[0].estado === 'finalizada') {
      return res.status(400).json({ error:"La minuta ya está finalizada" });
    }
    if (mR.rows[0].iniciada_por !== u.id) {
      return res.status(403).json({ error:"Solo la persona que inició la minuta puede finalizarla." });
    }
    await pool.query(
      "UPDATE minutas SET estado='finalizada', updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    res.json({ ok:true });
  } catch (e) {
    console.error("POST /minutas/:id/finalizar:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
//  POST /:id/reabrir  — reabrir minuta (solo el creador)
// ───────────────────────────────────────────────────────────────────────
router.post("/:id/reabrir", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  try {
    const mR = await pool.query("SELECT iniciada_por FROM minutas WHERE id=$1", [req.params.id]);
    if (!mR.rows.length) return res.status(404).json({ error:"Minuta no encontrada" });
    if (mR.rows[0].iniciada_por !== u.id) {
      return res.status(403).json({ error:"Solo la persona que inició la minuta puede reabrirla." });
    }
    await pool.query(
      "UPDATE minutas SET estado='en_curso', updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    res.json({ ok:true });
  } catch (e) {
    console.error("POST /minutas/:id/reabrir:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
//  DELETE /:id  — eliminar minuta (libera consecutivo)
// ───────────────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
  const u = req.session.usuario;
  try {
    const mR = await pool.query(
      "SELECT iniciada_por, consecutivo_id, numero, anio FROM minutas WHERE id=$1",
      [req.params.id]
    );
    if (!mR.rows.length) return res.status(404).json({ error:"Minuta no encontrada" });
    const m = mR.rows[0];
    if (m.iniciada_por !== u.id) {
      return res.status(403).json({ error:"Solo la persona que inició la minuta puede eliminarla." });
    }
    // Borrar la minuta. El consecutivo se marca como eliminado para liberar el número.
    await pool.query("DELETE FROM minutas WHERE id=$1", [req.params.id]);
    if (m.consecutivo_id) {
      await pool.query(
        "UPDATE consecutivos SET eliminado=true WHERE id=$1",
        [m.consecutivo_id]
      );
    }
    console.log(`[MINUTA] Eliminada N°${m.numero}-${m.anio} por usuario ${u.id} (${u.rol})`);
    res.json({ ok:true });
  } catch (e) {
    console.error("DELETE /minutas/:id:", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
